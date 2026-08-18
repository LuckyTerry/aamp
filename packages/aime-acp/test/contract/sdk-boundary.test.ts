import { readdir, readFile } from 'node:fs/promises';
import { relative } from 'node:path';

import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

const sourceRoot = new URL('../../src/', import.meta.url);
const adapterPath = 'src/aime/bytedcli-transport.ts';
const lazyImportPaths = new Set(['src/auth/provider.ts', adapterPath]);
const forbiddenCalls = new Set([
  'exec',
  'spawn',
  'getBytecloudJwt',
  'getBytecloudJwtToken',
  'logout',
]);

type AstNode = Readonly<Record<string, unknown>>;

async function sourceFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? sourceFiles(new URL(`${entry.name}/`, directory))
        : [new URL(entry.name, directory)],
    ),
  );
  return nested.flat().filter((file) => file.pathname.endsWith('.ts'));
}

function node(value: unknown): AstNode | undefined {
  return typeof value === 'object' && value !== null
    ? (value as AstNode)
    : undefined;
}

function nodes(value: unknown): readonly AstNode[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const parsed = node(item);
        return parsed === undefined ? [] : [parsed];
      })
    : [];
}

function typeOf(value: AstNode | undefined): string | undefined {
  return value !== undefined && typeof value.type === 'string'
    ? value.type
    : undefined;
}

function identifier(value: unknown): string | undefined {
  const parsed = node(value);
  return parsed !== undefined &&
    typeOf(parsed) === 'Identifier' &&
    typeof parsed.name === 'string'
    ? parsed.name
    : undefined;
}

function literal(value: unknown): string | undefined {
  const parsed = node(value);
  return parsed !== undefined &&
    typeOf(parsed) === 'Literal' &&
    typeof parsed.value === 'string'
    ? parsed.value
    : undefined;
}

function unwrap(value: unknown): AstNode | undefined {
  const parsed = node(value);
  if (parsed === undefined) return undefined;
  return typeOf(parsed) === 'ChainExpression'
    ? node(parsed.expression)
    : parsed;
}

function memberName(value: unknown): string | undefined {
  const parsed = unwrap(value);
  if (parsed === undefined || typeOf(parsed) !== 'MemberExpression')
    return undefined;
  return parsed.computed === true
    ? literal(parsed.property)
    : identifier(parsed.property);
}

function isApiAccess(value: unknown): boolean {
  const access = unwrap(value);
  return typeOf(access) === 'MemberExpression' && memberName(access) === 'api';
}

function isAimeAccess(value: unknown): boolean {
  const access = unwrap(value);
  return (
    access !== undefined &&
    typeOf(access) === 'MemberExpression' &&
    memberName(access) === 'aime' &&
    memberName(access.object) === 'api'
  );
}

function aimeRoot(value: unknown): AstNode | undefined {
  const access = unwrap(value);
  if (access === undefined) return undefined;
  if (isAimeAccess(access)) return access;
  return typeOf(access) === 'MemberExpression'
    ? aimeRoot(access.object)
    : undefined;
}

function hasUnsafeSegment(value: unknown): boolean {
  const access = unwrap(value);
  if (access === undefined || typeOf(access) !== 'MemberExpression')
    return false;
  return (
    access.computed === true ||
    access.optional === true ||
    hasUnsafeSegment(access.object)
  );
}

function isAimeCall(value: AstNode): boolean {
  return (
    typeOf(value) === 'CallExpression' &&
    aimeRoot(unwrap(value.callee)) !== undefined
  );
}

function isWithManagedUser(value: AstNode): boolean {
  const callee = unwrap(value.callee);
  return (
    callee !== undefined &&
    typeOf(callee) === 'MemberExpression' &&
    callee.computed !== true &&
    callee.optional !== true &&
    identifier(callee.property) === 'withManagedUser' &&
    typeOf(node(callee.object)) === 'ThisExpression'
  );
}

function isCallback(value: AstNode | undefined): boolean {
  return (
    typeOf(value) === 'ArrowFunctionExpression' ||
    typeOf(value) === 'FunctionExpression'
  );
}

function isBytedcliPackage(value: unknown): boolean {
  return literal(value) === '@bytedance-dev/bytedcli';
}

function isBytedcliSubpath(value: unknown): boolean {
  return literal(value)?.startsWith('@bytedance-dev/bytedcli/') === true;
}

function isForbiddenModule(value: unknown): boolean {
  const moduleName = literal(value)?.toLowerCase();
  return (
    moduleName === 'child_process' ||
    moduleName === 'node:child_process' ||
    moduleName?.includes('togo') === true
  );
}

function namesInPattern(value: unknown): readonly string[] {
  const parsed = node(value);
  if (parsed === undefined) return [];
  const name = identifier(parsed);
  if (name !== undefined) return [name];
  return Object.values(parsed).flatMap((child) =>
    Array.isArray(child)
      ? child.flatMap((item) => namesInPattern(item))
      : namesInPattern(child),
  );
}

function propertyNames(value: unknown, keyName: string): readonly string[] {
  const pattern = node(value);
  if (typeOf(pattern) !== 'ObjectPattern') return [];
  return nodes(pattern?.properties).flatMap((property) =>
    identifier(property.key) === keyName ? namesInPattern(property.value) : [],
  );
}

function isAimeDestructure(value: unknown): boolean {
  const parsed = node(value);
  return (
    typeOf(parsed) === 'ObjectPattern' &&
    nodes(parsed?.properties).some(
      (property) => identifier(property.key) === 'aime',
    )
  );
}

function hasNestedAimeBinding(value: unknown, insideApi = false): boolean {
  const pattern = node(value);
  if (pattern === undefined) return false;
  if (typeOf(pattern) === 'AssignmentPattern')
    return hasNestedAimeBinding(pattern.left, insideApi);
  if (typeOf(pattern) === 'RestElement')
    return hasNestedAimeBinding(pattern.argument, insideApi);
  if (typeOf(pattern) !== 'ObjectPattern') return false;
  return nodes(pattern?.properties).some((property) => {
    const key = identifier(property.key);
    if (insideApi && key === 'aime') return true;
    return hasNestedAimeBinding(property.value, insideApi || key === 'api');
  });
}

function hasSensitiveParameterBinding(value: unknown): boolean {
  const pattern = node(value);
  if (pattern === undefined) return false;
  if (
    typeOf(pattern) === 'AssignmentPattern' ||
    typeOf(pattern) === 'RestElement'
  )
    return hasSensitiveParameterBinding(
      typeOf(pattern) === 'AssignmentPattern' ? pattern.left : pattern.argument,
    );
  if (typeOf(pattern) !== 'ObjectPattern') return false;
  return nodes(pattern.properties).some((property) => {
    const key = identifier(property.key);
    return (
      key === 'api' ||
      key === 'aime' ||
      hasSensitiveParameterBinding(property.value)
    );
  });
}

function inspectSource(source: string, relativePath: string): string[] {
  const violations: string[] = [];
  const aimeAliases = new Set<string>();
  const facadeAliases = new Set(['facade']);
  const apiAliases = new Set<string>();
  const createRequireImports = new Set<string>();
  const createRequireAliases = new Set<string>();
  const program = parseAst(
    source,
    { lang: 'ts' },
    relativePath,
  ) as unknown as AstNode;

  const inspectModule = (
    sourceNode: unknown,
    kind: 'dynamic' | 'import' | 'export',
  ): void => {
    if (isForbiddenModule(sourceNode)) {
      violations.push(`${relativePath}: forbidden import`);
      return;
    }
    if (isBytedcliSubpath(sourceNode)) {
      violations.push(`${relativePath}: bytedcli subpath import`);
      return;
    }
    if (!isBytedcliPackage(sourceNode)) return;
    if (kind === 'dynamic' && lazyImportPaths.has(relativePath)) return;
    violations.push(
      `${relativePath}: ${kind === 'export' ? 'static bytedcli export' : kind === 'import' ? 'static bytedcli import' : 'unapproved dynamic bytedcli import'}`,
    );
  };

  const trackFacadeAlias = (left: unknown, right: unknown): boolean => {
    const rightName = identifier(right);
    const names = namesInPattern(left);
    if (rightName !== undefined && facadeAliases.has(rightName)) {
      const apiNames = propertyNames(left, 'api');
      if (apiNames.length > 0) {
        for (const name of apiNames) apiAliases.add(name);
        return true;
      }
      for (const name of names) facadeAliases.add(name);
      return true;
    }
    if (rightName !== undefined && apiAliases.has(rightName)) {
      const aimeNames = propertyNames(left, 'aime');
      if (aimeNames.length > 0) {
        for (const name of aimeNames) aimeAliases.add(name);
        return true;
      }
      for (const name of names) apiAliases.add(name);
      return true;
    }
    if (isApiAccess(right)) {
      for (const name of names) apiAliases.add(name);
      return true;
    }
    return false;
  };

  const visit = (
    current: AstNode,
    inManagedCallback: boolean,
    directAimeCallee = false,
  ): void => {
    const currentType = typeOf(current);
    if (currentType === 'ImportDeclaration') {
      inspectModule(current.source, 'import');
      if (literal(current.source) === 'node:module') {
        for (const specifier of nodes(current.specifiers)) {
          if (identifier(specifier.imported) === 'createRequire') {
            const local = identifier(specifier.local);
            if (local !== undefined) createRequireImports.add(local);
          }
        }
      }
    }
    if (
      currentType === 'ExportAllDeclaration' ||
      currentType === 'ExportNamedDeclaration'
    )
      inspectModule(current.source, 'export');
    if (currentType === 'ImportExpression')
      inspectModule(current.source, 'dynamic');

    if (
      (currentType === 'FunctionDeclaration' ||
        currentType === 'FunctionExpression' ||
        currentType === 'ArrowFunctionExpression') &&
      nodes(current.params).some(hasSensitiveParameterBinding)
    )
      violations.push(
        `${relativePath}: AIME facade parameter binding is forbidden`,
      );

    if (
      currentType === 'CatchClause' &&
      hasSensitiveParameterBinding(current.param)
    )
      violations.push(
        `${relativePath}: AIME facade parameter binding is forbidden`,
      );

    if (currentType === 'VariableDeclarator') {
      const directAimeAlias =
        isAimeAccess(current.init) ||
        (isAimeDestructure(current.id) && isApiAccess(current.init)) ||
        hasNestedAimeBinding(current.id);
      const extractedAlias = trackFacadeAlias(current.id, current.init);
      if (directAimeAlias || extractedAlias) {
        for (const name of namesInPattern(current.id)) aimeAliases.add(name);
        violations.push(`${relativePath}: AIME facade alias is forbidden`);
      }
    }
    if (
      currentType === 'VariableDeclarator' &&
      typeOf(node(current.init)) === 'CallExpression' &&
      createRequireImports.has(identifier(node(current.init)?.callee) ?? '')
    ) {
      const name = identifier(current.id);
      if (name !== undefined) createRequireAliases.add(name);
    }
    if (currentType === 'AssignmentExpression') {
      const directAimeAlias =
        isAimeAccess(current.right) || hasNestedAimeBinding(current.left);
      const extractedAlias = trackFacadeAlias(current.left, current.right);
      if (directAimeAlias || extractedAlias) {
        for (const name of namesInPattern(current.left)) aimeAliases.add(name);
        violations.push(`${relativePath}: AIME facade alias is forbidden`);
      }
    }

    if (isAimeAccess(current)) {
      if (relativePath !== adapterPath)
        violations.push(`${relativePath}: api.aime outside adapter`);
      if (hasUnsafeSegment(current))
        violations.push(`${relativePath}: computed or optional AIME access`);
      if (!directAimeCallee)
        violations.push(
          `${relativePath}: AIME facade access outside direct call`,
        );
    }

    if (currentType === 'CallExpression') {
      const callee = unwrap(current.callee);
      const callName = identifier(callee) ?? memberName(callee);
      const argumentsList = nodes(current.arguments);
      const resolverAllowed =
        relativePath === adapterPath &&
        memberName(callee) === 'resolve' &&
        createRequireAliases.has(identifier(node(callee)?.object) ?? '') &&
        isBytedcliPackage(argumentsList[0]);
      if (memberName(callee) === 'resolve' && !resolverAllowed)
        violations.push(`${relativePath}: global module lookup`);
      if (
        isBytedcliPackage(argumentsList[0]) ||
        isBytedcliSubpath(argumentsList[0])
      ) {
        if (!resolverAllowed) {
          violations.push(
            `${relativePath}: ${isBytedcliSubpath(argumentsList[0]) ? 'bytedcli subpath import' : 'CommonJS bytedcli load'}`,
          );
        }
      }
      if (forbiddenCalls.has(callName ?? ''))
        violations.push(`${relativePath}: forbidden call`);
      if (isAimeCall(current) && !inManagedCallback)
        violations.push(`${relativePath}: unguarded api.aime call`);
      if (aimeAliases.has(identifier(callee) ?? ''))
        violations.push(`${relativePath}: AIME alias call is forbidden`);

      if (isWithManagedUser(current)) {
        for (const [index, argument] of argumentsList.entries()) {
          visit(argument, index === 1 && isCallback(argument));
        }
        return;
      }
      if (isAimeCall(current)) {
        if (callee !== undefined) visit(callee, inManagedCallback, true);
        for (const argument of argumentsList)
          visit(argument, inManagedCallback);
        return;
      }
    }

    for (const value of Object.values(current)) {
      if (typeof value !== 'object' || value === null) continue;
      if (Array.isArray(value)) {
        for (const child of nodes(value))
          visit(child, inManagedCallback, directAimeCallee);
      } else {
        const child = node(value);
        if (child !== undefined)
          visit(child, inManagedCallback, directAimeCallee);
      }
    }
  };

  visit(program, false);
  return violations;
}

describe('SDK production boundary', () => {
  it.each([
    [
      'static import',
      "import sdk from '@bytedance-dev/bytedcli'",
      'static bytedcli import',
    ],
    [
      'static re-export',
      "export * from '@bytedance-dev/bytedcli'",
      'static bytedcli export',
    ],
    [
      'bytedcli subpath',
      "import sdk from '@bytedance-dev/bytedcli/dist/index.js'",
      'bytedcli subpath import',
    ],
    [
      'CommonJS require',
      "require('@bytedance-dev/bytedcli')",
      'CommonJS bytedcli load',
    ],
    [
      'createRequire load',
      "createRequire(import.meta.url)('@bytedance-dev/bytedcli')",
      'CommonJS bytedcli load',
    ],
    [
      'computed AIME access',
      "withManagedUser('x', () => facade.api['aime'].sendMessage())",
      'computed or optional AIME access',
    ],
    [
      'optional AIME access',
      "withManagedUser('x', () => facade.api?.aime.sendMessage())",
      'computed or optional AIME access',
    ],
    [
      'future AIME method',
      'facade.api.aime.getSpace()',
      'unguarded api.aime call',
    ],
    [
      'other AIME method',
      'facade.api.aime.listSessions()',
      'unguarded api.aime call',
    ],
    ['chat method', 'facade.api.aime.chat()', 'unguarded api.aime call'],
    [
      'AIME alias call',
      'const aime = facade.api.aime; aime.sendMessage()',
      'AIME facade alias is forbidden',
    ],
    [
      'destructured AIME alias',
      'const { aime } = facade.api; aime.sendMessage()',
      'AIME facade alias is forbidden',
    ],
    [
      'assigned AIME alias',
      'let aime; aime = facade.api.aime; aime.sendMessage()',
      'AIME facade alias is forbidden',
    ],
    [
      'nested destructured AIME alias',
      'const { api: { aime } } = facade; aime.getSpace()',
      'AIME facade alias is forbidden',
    ],
    [
      'nested assigned AIME alias',
      'let aime; ({ api: { aime } } = facade); aime.getSpace()',
      'AIME facade alias is forbidden',
    ],
    [
      'two-step facade and API alias',
      'const { api } = facade; const { aime } = api; aime.getSpace()',
      'AIME facade alias is forbidden',
    ],
    [
      'two-step assignment alias',
      'let api; let aime; ({ api } = facade); ({ aime } = api); aime.getSpace()',
      'AIME facade alias is forbidden',
    ],
    [
      'renamed two-step alias',
      'const { api: selectedApi } = facade; const { aime: selectedAime } = selectedApi; selectedAime.chat()',
      'AIME facade alias is forbidden',
    ],
    [
      'long facade alias chain',
      'const x = facade; const { api: y } = x; const z = y; const { aime: q } = z; q.chat()',
      'AIME facade alias is forbidden',
    ],
    [
      'function parameter extraction',
      'function unsafe({ api: { aime } }: any) { aime.getSpace(); } unsafe(facade)',
      'AIME facade parameter binding is forbidden',
    ],
    [
      'renamed arrow parameter extraction',
      'const unsafe = ({ api: { aime: selectedAime } }: any) => selectedAime.getSpace(); unsafe(facade)',
      'AIME facade parameter binding is forbidden',
    ],
    [
      'multi-step parameter extraction',
      'function unsafe({ api: selectedApi = {} }: any, { aime: selectedAime }: any) { selectedAime.chat(); } unsafe(facade, selectedApi)',
      'AIME facade parameter binding is forbidden',
    ],
    [
      'rest and assignment parameter extraction',
      'const unsafe = ({ api: { aime } = {} }: any = {}, ...rest: any[]) => aime.getSpace(); unsafe(facade)',
      'AIME facade parameter binding is forbidden',
    ],
    [
      'catch parameter extraction',
      'try {} catch ({ api: { aime } }) { aime.getSpace(); }',
      'AIME facade parameter binding is forbidden',
    ],
    [
      'wrong callback argument',
      "withManagedUser(() => facade.api.aime.sendMessage(), 'operation')",
      'unguarded api.aime call',
    ],
    [
      'unrelated arrow',
      "withManagedUser('operation', value => value); facade.api.aime.sendMessage()",
      'unguarded api.aime call',
    ],
    [
      'foreign managed receiver',
      "other.withManagedUser('x', () => facade.api.aime.getSpace())",
      'unguarded api.aime call',
    ],
    [
      'computed managed receiver',
      "this['withManagedUser']('x', () => facade.api.aime.getSpace())",
      'unguarded api.aime call',
    ],
    [
      'optional managed receiver',
      "this?.withManagedUser('x', () => facade.api.aime.getSpace())",
      'unguarded api.aime call',
    ],
    [
      'dynamic child process',
      "import('node:child_process')",
      'forbidden import',
    ],
    [
      'unrelated require resolve',
      "require.resolve('some-module')",
      'global module lookup',
    ],
    [
      'child process import',
      "import { exec } from 'node:child_process'",
      'forbidden import',
    ],
    ['forbidden auth call', 'facade.auth.logout()', 'forbidden call'],
  ])('rejects %s as %s', (_label, source, expected) => {
    expect(inspectSource(source, adapterPath)).toContain(
      `${adapterPath}: ${expected}`,
    );
  });

  it('permits only createRequire-derived package resolution', () => {
    expect(
      inspectSource(
        "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); require.resolve('@bytedance-dev/bytedcli')",
        adapterPath,
      ),
    ).toEqual([]);
  });

  it('rejects resolution when createRequire was not imported from node:module', () => {
    expect(
      inspectSource(
        "const require = createRequire(import.meta.url); require.resolve('@bytedance-dev/bytedcli')",
        adapterPath,
      ),
    ).toContain(`${adapterPath}: global module lookup`);
  });

  it('permits package resolution only in the adapter file', () => {
    expect(
      inspectSource(
        "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); require.resolve('@bytedance-dev/bytedcli')",
        'src/auth/provider.ts',
      ),
    ).toContain('src/auth/provider.ts: global module lookup');
  });

  it('keeps real production source inside the boundary', async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(sourceRoot)) {
      const code = await readFile(file, 'utf8');
      const relativePath = relative(
        new URL('../../', import.meta.url).pathname,
        file.pathname,
      );
      violations.push(...inspectSource(code, relativePath));
    }
    expect(violations).toEqual([]);
  });
});
