import type { Ctx } from '../../context.js';
import { FOREIGN_SOURCE, buildIgnoreFilter, readGitignore, sourceLanguage, type Project } from '../ast/indexer.js';
import { loadPackages, type PackageInfo } from '../ast/packages.js';
import { TSCONFIG_NAME, diskReader, loadTsConfigs, type ConfigReader, type TsConfigInfo } from '../ast/tsconfig.js';
import { listTreeAtCommit, readBlob, readAtCommitSync } from '../git/git.js';
import { configFileName, parseConfigText, type Config } from '../../utils/config.js';
import { errorMessage } from '../../utils/errors.js';
import { compareText } from '../../utils/text.js';

// What the project's own configuration said at the base commit. A baseline built from today's configuration
// would blame (or excuse) a change for effects of a tsconfig, ignore rule or path alias edited since.
export type BaselineRules = {
  // Eligible source files tracked at the base commit, after the ignore rules of that commit.
  paths: string[];
  tsconfigs: TsConfigInfo[];
  packages: PackageInfo[];
  foreignExtensions: string[];
  config: Config;
  // Human-readable list of configuration inputs that differ between the base commit and the working tree.
  changed: string[];
  notes: string[];
  // Configuration that exists at the base commit but could not be read back or parsed. Findings compared against a
  // baseline built without it may be wrong, so the validation is reported as partial.
  unreconstructable: string[];
};

const MAX_CONFIG_BYTES = 256 * 1024;

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => compareText(a, b)))
      : v,
  );
}

// Config files resolved through node_modules are not tracked by git, so those come from the working tree.
function readerAt(ctx: Ctx, sha: string): ConfigReader {
  const disk = diskReader(ctx.root);
  return (rel) => {
    if (rel.split('/').includes('node_modules')) return disk(rel);
    return readAtCommitSync(ctx.root, sha, rel, MAX_CONFIG_BYTES)?.toString('utf8') ?? null;
  };
}

export async function reconstructBaseline(ctx: Ctx, sha: string, project: Pick<Project, 'tsconfigs' | 'packages'>): Promise<BaselineRules | null> {
  const tree = await listTreeAtCommit(ctx.root, sha);
  if (!tree) return null;

  const notes: string[] = [];
  const changed: string[] = [];
  const unreconstructable: string[] = [];

  let historical: Config = parseConfigText('{}');
  if (tree.includes(configFileName)) {
    const blob = await readBlob(ctx.root, sha, configFileName, MAX_CONFIG_BYTES);
    if (!blob.ok) {
      unreconstructable.push(`${configFileName} exists at the base commit but could not be read (${blob.reason}); defaults were used for it`);
    } else {
      try {
        historical = parseConfigText(blob.data.toString('utf8'));
      } catch (err) {
        unreconstructable.push(`${configFileName} at the base commit is invalid (${errorMessage(err).split('\n')[0]}); defaults were used for it`);
      }
    }
  }
  // Resource limits and LLM switches describe this run, not the project's rules.
  const config: Config = { ...historical, maxFiles: ctx.config.maxFiles, maxFileKb: ctx.config.maxFileKb, contextTokens: ctx.config.contextTokens, llm: ctx.config.llm };

  let gitignoreThen = '';
  if (tree.includes('.gitignore')) {
    const blob = await readBlob(ctx.root, sha, '.gitignore', 256 * 1024);
    if (blob.ok) gitignoreThen = blob.data.toString('utf8');
    else unreconstructable.push(`.gitignore exists at the base commit but could not be read (${blob.reason}); the files it ignored then are unknown`);
  }
  const filter = buildIgnoreFilter(gitignoreThen, config.ignore);

  const paths = tree.filter((p) => sourceLanguage(p) && !filter.ignores(p)).sort(compareText);
  const configFiles = tree.filter((p) => TSCONFIG_NAME.test(p.split('/').pop() ?? '') && !filter.ignores(p));
  const packageFiles = tree.filter((p) => ['package.json', 'pyproject.toml'].includes(p.split('/').pop() ?? '') && !filter.ignores(p));
  const reader = readerAt(ctx, sha);
  const tsconfigs = loadTsConfigs(reader, configFiles);
  const packages = loadPackages(reader, packageFiles);

  // A config file that loads today but not at the base (unreadable, invalid, or an `extends` that cannot be found)
  // leaves the baseline without aliases, references or framework signals it really had.
  const loadedNow = (files: { file: string }[]): Set<string> => new Set(files.map((f) => f.file));
  const missing = (wanted: string[], got: { file: string }[], now: Set<string>): string[] => {
    const have = loadedNow(got);
    return wanted.filter((f) => !have.has(f) && now.has(f));
  };
  for (const file of missing(configFiles, tsconfigs, loadedNow(project.tsconfigs))) unreconstructable.push(`${file} could not be read or parsed at the base commit`);
  for (const file of missing(packageFiles, packages, loadedNow(project.packages))) unreconstructable.push(`${file} could not be read or parsed at the base commit`);

  const ruleSettings = (c: Pick<Config, 'ignore' | 'pythonRoots' | 'profile' | 'entryPoints' | 'rules' | 'exceptions'>): string =>
    stable({ ignore: c.ignore, pythonRoots: c.pythonRoots, profile: c.profile, entryPoints: c.entryPoints, rules: c.rules, exceptions: c.exceptions });
  // Only what resolution and entry-point detection read from a manifest: names, entry fields, exports/imports and detected frameworks.
  const manifestView = (list: PackageInfo[]): string => stable(list.map(({ file, name, main, module, types, bin, exports, imports, frameworks }) => ({ file, name, main, module, types, bin, exports, imports, frameworks })));

  if (ruleSettings(config) !== ruleSettings(ctx.config)) changed.push(configFileName);
  if (gitignoreThen !== readGitignore(ctx.root)) changed.push('.gitignore');
  if (stable(tsconfigs) !== stable(project.tsconfigs)) changed.push('tsconfig/jsconfig');
  if (manifestView(packages) !== manifestView(project.packages)) changed.push('package.json (frameworks, exports, workspaces)');

  if (changed.length > 0) {
    notes.push(`Project configuration differs from the base commit (${changed.join(', ')}). The baseline was rebuilt with the configuration that existed then.`);
  }
  const foreignExtensions = [...new Set(tree.filter((p) => !filter.ignores(p)).map((p) => (p.match(/\.[^./]+$/)?.[0] ?? '').toLowerCase()).filter((e) => FOREIGN_SOURCE.has(e)))].sort();
  return { paths, tsconfigs, packages, foreignExtensions, config, changed, notes, unreconstructable };
}
