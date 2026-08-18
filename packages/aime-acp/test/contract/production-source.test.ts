import { readdir, readFile } from 'node:fs/promises';
import { relative } from 'node:path';

import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

type AstNode = Readonly<Record<string, unknown>>;

const packageRoot = new URL('../../', import.meta.url);
const sourceRoot = new URL('../../src/', import.meta.url);
const sensitiveRoots = ['src/acp/', 'src/session/', 'src/aime/'];
const forbiddenModules = new Set([
  'child_process',
  'node:child_process',
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'fast-glob',
]);
const forbiddenAcpMethods = new Set([
  'session/request_permission',
  'fs/read_text_file',
  'fs/write_text_file',
  'terminal/create',
  'terminal/output',
  'terminal/wait_for_exit',
  'terminal/kill',
  'mcp/connect',
  'mcp/message',
  'mcp/disconnect',
]);
const sensitiveTraversalCalls = new Set([
  'chdir',
  'cwd',
  'glob',
  'open',
  'readdir',
  'readFile',
  'stat',
]);
const approvedAdapterPaths = new Set([
  'src/aime/bytedcli-transport.ts',
  'dist/aime/bytedcli-transport.js',
]);

function node(value: unknown): AstNode | undefined {
  return typeof value === 'object' && value !== null
    ? (value as AstNode)
    : undefined;
}

function typeOf(value: AstNode | undefined): string | undefined {
  return typeof value?.type === 'string' ? value.type : undefined;
}

function literal(value: unknown): string | undefined {
  const parsed = node(value);
  return typeOf(parsed) === 'Literal' && typeof parsed?.value === 'string'
    ? parsed.value
    : undefined;
}

function identifier(value: unknown): string | undefined {
  const parsed = node(value);
  return typeOf(parsed) === 'Identifier' && typeof parsed?.name === 'string'
    ? parsed.name
    : undefined;
}

function memberName(value: unknown): string | undefined {
  const parsed = node(value);
  if (typeOf(parsed) !== 'MemberExpression') return undefined;
  return parsed?.computed === true
    ? literal(parsed.property)
    : identifier(parsed?.property);
}

async function filesBelow(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? filesBelow(new URL(`${entry.name}/`, directory))
          : [new URL(entry.name, directory)],
      ),
    )
  ).flat();
}

function inspectAst(source: string, path: string, lang: 'ts' | 'js'): string[] {
  const violations: string[] = [];
  const ast = parseAst(source, { lang }, path) as unknown as AstNode;
  const sensitive = sensitiveRoots.some((root) => path.startsWith(root));
  const createRequireNames = new Set<string>();
  const moduleNamespaceNames = new Set<string>();
  const requireNames = new Set(['require']);

  const callArguments = (value: AstNode | undefined): readonly unknown[] =>
    typeOf(value) === 'CallExpression' && Array.isArray(value?.arguments)
      ? value.arguments
      : [];

  const isRequireCallFor = (value: unknown, specifier: string): boolean => {
    const call = node(value);
    return (
      typeOf(call) === 'CallExpression' &&
      requireNames.has(identifier(call?.callee) ?? '') &&
      literal(callArguments(call)[0]) === specifier
    );
  };

  const isCreateRequireCallee = (value: unknown): boolean => {
    const callee = node(value);
    const calleeName = identifier(callee);
    if (calleeName !== undefined && createRequireNames.has(calleeName))
      return true;
    if (
      typeOf(callee) !== 'MemberExpression' ||
      memberName(callee) !== 'createRequire'
    )
      return false;
    const objectName = identifier(callee?.object);
    return (
      (objectName !== undefined && moduleNamespaceNames.has(objectName)) ||
      isRequireCallFor(callee?.object, 'node:module') ||
      isRequireCallFor(callee?.object, 'module')
    );
  };

  const commonJsSpecifier = (current: AstNode): string | undefined => {
    const callee = node(current.callee);
    const directName = identifier(callee);
    if (directName !== undefined && requireNames.has(directName))
      return literal(callArguments(current)[0]);
    if (
      typeOf(callee) === 'CallExpression' &&
      isCreateRequireCallee(callee?.callee)
    )
      return literal(callArguments(current)[0]);
    return undefined;
  };

  const visit = (current: AstNode): void => {
    const currentType = typeOf(current);
    if (
      currentType === 'ImportDeclaration' ||
      currentType === 'ExportAllDeclaration' ||
      currentType === 'ExportNamedDeclaration'
    ) {
      const specifier = literal(current.source)?.toLowerCase();
      if (specifier === 'node:module' || specifier === 'module') {
        const specifiers = Array.isArray(current.specifiers)
          ? current.specifiers
          : [];
        for (const rawSpecifier of specifiers) {
          const specifierNode = node(rawSpecifier);
          const localName = identifier(specifierNode?.local);
          if (localName === undefined) continue;
          if (typeOf(specifierNode) === 'ImportNamespaceSpecifier') {
            moduleNamespaceNames.add(localName);
          } else if (identifier(specifierNode?.imported) === 'createRequire') {
            createRequireNames.add(localName);
          }
        }
      }
      if (specifier?.includes('togo'))
        violations.push(`${path}: forbidden Togo import`);
      if (
        specifier !== undefined &&
        (specifier === 'child_process' || specifier === 'node:child_process')
      ) {
        violations.push(`${path}: child_process import`);
      }
      if (
        sensitive &&
        specifier !== undefined &&
        forbiddenModules.has(specifier)
      )
        violations.push(`${path}: workspace-capable import ${specifier}`);
    }
    if (currentType === 'ImportExpression') {
      const specifier = literal(current.source)?.toLowerCase();
      if (specifier?.includes('togo'))
        violations.push(`${path}: forbidden dynamic Togo import`);
      if (
        specifier !== undefined &&
        (specifier === 'child_process' || specifier === 'node:child_process')
      ) {
        violations.push(`${path}: dynamic child_process import`);
      }
      if (
        sensitive &&
        specifier !== undefined &&
        forbiddenModules.has(specifier)
      )
        violations.push(
          `${path}: workspace-capable dynamic import ${specifier}`,
        );
    }
    if (currentType === 'VariableDeclarator') {
      const localName = identifier(current.id);
      const initializer = node(current.init);
      const initializesFromModule =
        isRequireCallFor(initializer, 'node:module') ||
        isRequireCallFor(initializer, 'module');
      if (localName !== undefined && initializesFromModule)
        moduleNamespaceNames.add(localName);
      if (
        typeOf(node(current.id)) === 'ObjectPattern' &&
        initializesFromModule
      ) {
        const rawProperties = node(current.id)?.properties;
        const properties = Array.isArray(rawProperties) ? rawProperties : [];
        for (const rawProperty of properties) {
          const property = node(rawProperty);
          if (identifier(property?.key) !== 'createRequire') continue;
          const alias = identifier(property?.value);
          if (alias !== undefined) createRequireNames.add(alias);
        }
      }
      if (
        localName !== undefined &&
        (isCreateRequireCallee(initializer) ||
          createRequireNames.has(identifier(initializer) ?? ''))
      ) {
        createRequireNames.add(localName);
      }
      if (
        localName !== undefined &&
        typeOf(initializer) === 'CallExpression' &&
        isCreateRequireCallee(initializer?.callee)
      ) {
        requireNames.add(localName);
      } else if (
        localName !== undefined &&
        requireNames.has(identifier(initializer) ?? '')
      ) {
        requireNames.add(localName);
      }
    }
    if (currentType === 'CallExpression') {
      const callee = node(current.callee);
      const name = identifier(callee) ?? memberName(callee);
      const args = Array.isArray(current.arguments) ? current.arguments : [];
      const firstString = literal(args[0]);
      const loadedModule = commonJsSpecifier(current)?.toLowerCase();
      if (loadedModule?.includes('togo'))
        violations.push(`${path}: forbidden CommonJS Togo load`);
      if (
        loadedModule === 'child_process' ||
        loadedModule === 'node:child_process'
      )
        violations.push(`${path}: CommonJS child_process load`);
      if (
        sensitive &&
        loadedModule !== undefined &&
        forbiddenModules.has(loadedModule)
      )
        violations.push(
          `${path}: workspace-capable CommonJS load ${loadedModule}`,
        );
      if (sensitive && sensitiveTraversalCalls.has(name ?? ''))
        violations.push(`${path}: workspace traversal call ${String(name)}`);
      if (name === 'spawn' || name === 'exec' || name === 'execFile')
        violations.push(`${path}: process execution call`);
      if (
        name === 'resolve' &&
        firstString?.toLowerCase().includes('bytedcli') === true &&
        (firstString !== '@bytedance-dev/bytedcli' ||
          !approvedAdapterPaths.has(path))
      )
        violations.push(`${path}: unapproved global bytedcli resolution`);
      if (
        name === 'require' &&
        firstString?.toLowerCase().includes('togo') === true
      )
        violations.push(`${path}: forbidden CommonJS Togo load`);
      if (
        firstString !== undefined &&
        forbiddenAcpMethods.has(firstString.toLowerCase())
      ) {
        violations.push(`${path}: forbidden ACP/MCP call ${firstString}`);
      }
      if (
        ['spawn', 'exec', 'execFile'].includes(name ?? '') &&
        firstString?.toLowerCase().includes('bytedcli')
      ) {
        violations.push(`${path}: global bytedcli execution`);
      }
    }
    for (const value of Object.values(current)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          const parsed = node(child);
          if (parsed !== undefined) visit(parsed);
        }
      } else {
        const parsed = node(value);
        if (parsed !== undefined) visit(parsed);
      }
    }
  };
  visit(ast);
  return violations;
}

describe('production source and package candidate boundary', () => {
  it.each([
    {
      path: 'src/acp/adversarial.ts',
      source: "const cp = require('node:child_process'); cp.spawn('x')",
      expected: 'child_process',
    },
    {
      path: 'src/session/adversarial.ts',
      source:
        "import { createRequire as makeRequire } from 'node:module'; const localRequire = makeRequire(import.meta.url); localRequire('node:fs')",
      expected: 'node:fs',
    },
    {
      path: 'src/aime/adversarial.ts',
      source:
        "import * as moduleApi from 'node:module'; moduleApi.createRequire(import.meta.url)('node:fs/promises')",
      expected: 'node:fs/promises',
    },
    {
      path: 'src/aime/adversarial.ts',
      source:
        "import { createRequire } from 'node:module'; const req = createRequire(import.meta.url); req('node:child_process')",
      expected: 'child_process',
    },
    {
      path: 'src/session/adversarial.ts',
      source:
        "const { createRequire: makeRequire } = require('node:module'); makeRequire(import.meta.url)('node:fs/promises')",
      expected: 'node:fs/promises',
    },
    {
      path: 'src/acp/adversarial.ts',
      source:
        "const makeRequire = require('node:module').createRequire; const req = makeRequire(import.meta.url); req('node:child_process')",
      expected: 'child_process',
    },
    {
      path: 'src/aime/adversarial.ts',
      source:
        "import * as moduleApi from 'node:module'; const makeRequire = moduleApi.createRequire; const alias = makeRequire; alias(import.meta.url)('node:fs')",
      expected: 'node:fs',
    },
    {
      path: 'src/acp/adversarial.ts',
      source:
        "const moduleApi = require('node:module'); moduleApi.createRequire(import.meta.url)('node:child_process')",
      expected: 'child_process',
    },
    {
      path: 'src/session/adversarial.ts',
      source:
        "const moduleApi = require('module'); const makeRequire = moduleApi.createRequire; const alias = makeRequire; alias(import.meta.url)('node:fs/promises')",
      expected: 'node:fs/promises',
    },
  ])(
    'rejects CommonJS production escape: $source',
    ({ path, source, expected }) => {
      expect(inspectAst(source, path, 'ts').join('\n')).toContain(expected);
    },
  );

  it('keeps the approved adapter package-version resolution allowed', () => {
    expect(
      inspectAst(
        "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); require.resolve('@bytedance-dev/bytedcli')",
        'src/aime/bytedcli-transport.ts',
        'ts',
      ),
    ).toEqual([]);
  });

  it('parses every production source and forbids workspace, process, Togo, and active ACP/MCP capabilities', async () => {
    const files = (await filesBelow(sourceRoot)).filter((file) =>
      file.pathname.endsWith('.ts'),
    );
    const violations = (
      await Promise.all(
        files.map(async (file) => {
          const path = relative(packageRoot.pathname, file.pathname);
          return inspectAst(await readFile(file, 'utf8'), path, 'ts');
        }),
      )
    ).flat();
    expect(violations).toEqual([]);
  });

  it('keeps the publish candidate limited and statically scans every built JavaScript file', async () => {
    const pkg = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { files?: unknown; bin?: unknown };
    expect(pkg.files).toEqual(['dist', 'README.md', 'LICENSE']);
    expect(pkg.bin).toEqual({ 'aime-acp': 'dist/bin.js' });

    const built = (
      await filesBelow(new URL('../../dist/', import.meta.url))
    ).filter((file) => file.pathname.endsWith('.js'));
    const violations = (
      await Promise.all(
        built.map(async (file) => {
          const path = relative(packageRoot.pathname, file.pathname);
          return inspectAst(await readFile(file, 'utf8'), path, 'js');
        }),
      )
    ).flat();
    expect(violations).toEqual([]);
  });
});
