#!/usr/bin/env python3
"""Compares the analysis with independent tools and writes eval/out/compare.json.

  python3 eval/compare.py <repos directory> <output directory> <node_modules directory containing typescript 5.x>

Automated checks (no human judgement):
  * unused-import   vs the TypeScript compiler (TS/JS repositories) and pyflakes (Python repositories)
  * duplicate-body  members re-extracted from the source and compared with a separate, cruder script
Everything else in docs/evaluation.md (cycles, unresolved imports, orphans, dead exports) was read by hand and is not
produced by this script; it prints those findings so they can be read.
"""
import json, os, re, subprocess, sys

repos_dir, out_dir, ts_modules = (os.path.abspath(a) for a in sys.argv[1:4])
here = os.path.dirname(os.path.abspath(__file__))
repos = json.load(open(os.path.join(here, 'repos.json')))
run = lambda *a, **k: subprocess.run(a, capture_output=True, text=True, **k)

versions = {
    'node': run('node', '--version').stdout.strip(),
    'git': run('git', '--version').stdout.strip(),
    'python': run('python3', '--version').stdout.strip(),
    'pyflakes': run('python3', '-m', 'pyflakes', '--version').stdout.strip().split(' ')[0],
    'typescript': json.load(open(os.path.join(ts_modules, 'typescript', 'package.json')))['version'],
}
result = {'versions': versions, 'unusedImports': {}, 'duplicateBodies': {}}

def findings(name, rule):
    return [f for f in json.load(open(os.path.join(out_dir, f'{name}.findings.json'))) if f['rule'] == rule]

def source_lines(root, rel):
    try:
        return open(os.path.join(root, rel), encoding='utf8', errors='ignore').read().splitlines()
    except OSError:
        return []

def function_body(root, rel, line):
    text = '\n'.join(source_lines(root, rel)[line - 1:line + 400])
    arrow, brace = text.find('=>'), text.find('{')
    start = text.find('{', arrow) if 0 <= arrow < brace or (arrow >= 0 and brace < 0) else brace
    if start < 0:
        return None
    depth = 0
    for k in range(start, len(text)):
        depth += (text[k] == '{') - (text[k] == '}')
        if depth == 0:
            return re.sub(r'\s+', ' ', text[start:k + 1]).strip()
    return None

for repo in repos:
    name, root = repo['name'], os.path.join(repos_dir, repo['name'])
    ours = {(f['file'], f['message'].split(' ')[0]) for f in findings(name, 'unused-import')}
    ours_files = {f for f, _ in ours}
    if name in ('requests', 'click'):
        out = run('python3', '-m', 'pyflakes', '.', cwd=root).stdout
        oracle = set()
        for line in out.splitlines():
            m = re.match(r"\./?(.+?):\d+:\d+:? .*?'(.+?)' imported but unused", line)
            if m:
                oracle.add((m.group(1), m.group(2).split('.')[-1].split(' as ')[-1]))
        init_only = sorted(x for x in oracle if x[0].endswith('__init__.py'))
        other = sorted(x for x in oracle if not x[0].endswith('__init__.py') and x not in ours)
        result['unusedImports'][name] = {'oracle': 'pyflakes', 'reported': len(ours), 'oracleTotal': len(oracle), 'bothReport': len(ours & oracle),
                                          'reportedOnlyByUs': sorted(ours - oracle), 'oracleOnlyInInit': len(init_only), 'oracleOnlyElsewhere': len(other)}
    else:
        oracle_json = os.path.join(out_dir, f'{name}.oracle-ts.json')
        env = dict(os.environ, TS_DIR=os.path.dirname(ts_modules))
        subprocess.run(['node', os.path.join(here, 'oracle-ts.cjs'), root, oracle_json], capture_output=True, env=env, check=True)
        files = set()
        for d in json.load(open(oracle_json)):
            src = source_lines(root, d['file']); i = d['line'] - 1
            for j in range(i, max(-1, i - 40), -1):
                if j >= len(src): break
                if re.match(r'\s*import\b', src[j]): files.add(d['file']); break
                if j != i and re.match(r'\s*(export|const|function|class|let|var|type|interface)\b', src[j]): break
        result['unusedImports'][name] = {'oracle': 'typescript compiler', 'reportedFiles': len(ours_files), 'oracleFiles': len(files), 'agreeFiles': len(ours_files & files),
                                          'reportedOnlyByUs': sorted(ours_files - files), 'oracleOnly': sorted(files - ours_files)}

    verified = not_identical = unknown = 0
    for f in findings(name, 'duplicate-body'):
        members = [(a, int(b)) for a, b in re.findall(r'\((\S+?):(\d+)\)', ' '.join(f['evidence']))]
        bodies = [function_body(root, a, b) if a.endswith(('.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs')) else None for a, b in members]
        if not members or any(b is None for b in bodies): unknown += 1
        elif len(set(bodies)) == 1: verified += 1
        else: not_identical += 1
    if verified + not_identical + unknown:
        result['duplicateBodies'][name] = {'groups': verified + not_identical + unknown, 'confirmedIdentical': verified, 'notConfirmed': not_identical, 'couldNotExtract': unknown}

os.makedirs(out_dir, exist_ok=True)
json.dump(result, open(os.path.join(out_dir, 'compare.json'), 'w'), indent=2, sort_keys=True)
print(json.dumps(result, indent=2, sort_keys=True))
