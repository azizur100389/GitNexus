import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { extractJavaDocComment, javaDescriptionExtractor } from '../../src/core/ingestion/languages/java.js';
import { JAVA_QUERIES } from '../../src/core/ingestion/tree-sitter-queries.js';
import { parseSourceSafe } from '../../src/core/tree-sitter/safe-parse.js';
import { getTreeSitterBufferSize } from '../../src/core/ingestion/constants.js';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';

function getJavaParser(): Parser {
  const parser = new Parser();
  parser.setLanguage(Java as Parameters<Parser['setLanguage']>[0]);
  return parser;
}

function buildCaptureMap(source: string): Record<string, SyntaxNode>[] {
  const parser = getJavaParser();
  const tree = parseSourceSafe(parser, source, undefined, {
    bufferSize: getTreeSitterBufferSize(source),
  });
  const query = new Parser.Query(Java as Parameters<Parser['setLanguage']>[0], JAVA_QUERIES);
  const matches = query.matches(tree.rootNode);
  const maps: Record<string, SyntaxNode>[] = [];
  for (const m of matches) {
    const map: Record<string, SyntaxNode> = {};
    for (const c of m.captures) {
      map[c.name] = c.node;
    }
    maps.push(map);
  }
  return maps;
}

function findCaptureMapByLabel(
  maps: Record<string, SyntaxNode>[],
  label: string,
): Record<string, SyntaxNode> | undefined {
  const labelMap: Record<string, string> = {
    Class: 'definition.class',
    Interface: 'definition.interface',
    Enum: 'definition.enum',
    Method: 'definition.method',
    Constructor: 'definition.constructor',
  };
  const tag = labelMap[label];
  if (!tag) return undefined;
  return maps.find((m) => m[tag] !== undefined);
}

describe('extractJavaDocComment', () => {
  it('extracts Javadoc from a class', () => {
    const src = `
      /** A simple user class. */
      class User {}
    `;
    const maps = buildCaptureMap(src);
    const map = findCaptureMapByLabel(maps, 'Class');
    expect(map).toBeDefined();
    const desc = extractJavaDocComment(map!['definition.class']);
    expect(desc).toBe('A simple user class.');
  });

  it('extracts Javadoc from a method', () => {
    const src = `
      class C {
        /** Returns the current count. */
        int getCount() { return 0; }
      }
    `;
    const maps = buildCaptureMap(src);
    const map = findCaptureMapByLabel(maps, 'Method');
    expect(map).toBeDefined();
    const desc = extractJavaDocComment(map!['definition.method']);
    expect(desc).toBe('Returns the current count.');
  });

  it('extracts Javadoc from a constructor', () => {
    const src = `
      class C {
        /** Creates a new instance. */
        C() {}
      }
    `;
    const maps = buildCaptureMap(src);
    const map = findCaptureMapByLabel(maps, 'Constructor');
    expect(map).toBeDefined();
    const desc = extractJavaDocComment(map!['definition.constructor']);
    expect(desc).toBe('Creates a new instance.');
  });

  it('extracts Javadoc from an interface', () => {
    const src = `
      /** A service interface. */
      interface Service {}
    `;
    const maps = buildCaptureMap(src);
    const map = findCaptureMapByLabel(maps, 'Interface');
    expect(map).toBeDefined();
    const desc = extractJavaDocComment(map!['definition.interface']);
    expect(desc).toBe('A service interface.');
  });

  it('extracts Javadoc from an enum', () => {
    const src = `
      /** Status codes. */
      enum Status { ACTIVE, INACTIVE }
    `;
    const maps = buildCaptureMap(src);
    const map = findCaptureMapByLabel(maps, 'Enum');
    expect(map).toBeDefined();
    const desc = extractJavaDocComment(map!['definition.enum']);
    expect(desc).toBe('Status codes.');
  });

  it('returns undefined when there is no Javadoc', () => {
    const src = `
      class User {}
    `;
    const maps = buildCaptureMap(src);
    const map = findCaptureMapByLabel(maps, 'Class');
    expect(map).toBeDefined();
    const desc = extractJavaDocComment(map!['definition.class']);
    expect(desc).toBeUndefined();
  });

  it('skips a non-Javadoc block comment and finds the Javadoc', () => {
    const src = `
      /* License header */
      /** A user class. */
      class User {}
    `;
    const maps = buildCaptureMap(src);
    const map = findCaptureMapByLabel(maps, 'Class');
    expect(map).toBeDefined();
    const desc = extractJavaDocComment(map!['definition.class']);
    expect(desc).toBe('A user class.');
  });

  it('stops at the first @ tag', () => {
    const src = `
      /**
       * Brief summary here.
       * @param name the name
       */
      class User {
        User(String name) {}
      }
    `;
    const maps = buildCaptureMap(src);
    const map = findCaptureMapByLabel(maps, 'Class');
    expect(map).toBeDefined();
    const desc = extractJavaDocComment(map!['definition.class']);
    expect(desc).toBe('Brief summary here.');
  });

  it('handles multi-line Javadoc summary', () => {
    const src = `
      /**
       * This is a longer description that
       * spans multiple lines.
       * @since 1.0
       */
      class User {}
    `;
    const maps = buildCaptureMap(src);
    const map = findCaptureMapByLabel(maps, 'Class');
    expect(map).toBeDefined();
    const desc = extractJavaDocComment(map!['definition.class']);
    expect(desc).toBe('This is a longer description that spans multiple lines.');
  });

  it('caps description at 150 characters', () => {
    const longText = 'A'.repeat(200);
    const src = `
      /** ${longText} */
      class User {}
    `;
    const maps = buildCaptureMap(src);
    const map = findCaptureMapByLabel(maps, 'Class');
    expect(map).toBeDefined();
    const desc = extractJavaDocComment(map!['definition.class']);
    expect(desc).toBe('A'.repeat(150));
  });

  it('returns undefined when Javadoc only contains tags', () => {
    const src = `
      /**
       * @deprecated use NewClass
       */
      class User {}
    `;
    const maps = buildCaptureMap(src);
    const map = findCaptureMapByLabel(maps, 'Class');
    expect(map).toBeDefined();
    const desc = extractJavaDocComment(map!['definition.class']);
    expect(desc).toBeUndefined();
  });

  it('does not walk past a named sibling to find older Javadoc', () => {
    const src = `
      class C {
        /** First method. */
        void first() {}

        /** Second method. */
        void second() {}
      }
    `;
    const maps = buildCaptureMap(src);
    // There should be two method matches
    const methodMaps = maps.filter((m) => m['definition.method'] !== undefined);
    expect(methodMaps.length).toBe(2);

    // For the first method, the Javadoc is immediately preceding
    // For the second method, the Javadoc is also immediately preceding
    const desc1 = extractJavaDocComment(methodMaps[0]['definition.method']);
    const desc2 = extractJavaDocComment(methodMaps[1]['definition.method']);
    // Both should get their own Javadoc, not cross-contaminate
    expect([desc1, desc2]).toContain('First method.');
    expect([desc1, desc2]).toContain('Second method.');
  });
});

describe('javaDescriptionExtractor', () => {
  it('maps Class label to definition.class capture', () => {
    const src = `/** A user class. */ class User {}`;
    const maps = buildCaptureMap(src);
    const map = findCaptureMapByLabel(maps, 'Class');
    expect(map).toBeDefined();
    const desc = javaDescriptionExtractor('Class', 'User', map!);
    expect(desc).toBe('A user class.');
  });

  it('maps Method label to definition.method capture', () => {
    const src = `
      class C {
        /** Gets count. */
        int getCount() { return 0; }
      }
    `;
    const maps = buildCaptureMap(src);
    const map = findCaptureMapByLabel(maps, 'Method');
    expect(map).toBeDefined();
    const desc = javaDescriptionExtractor('Method', 'getCount', map!);
    expect(desc).toBe('Gets count.');
  });

  it('maps Constructor label to definition.constructor capture', () => {
    const src = `
      class C {
        /** Creates a new instance. */
        C() {}
      }
    `;
    const maps = buildCaptureMap(src);
    const map = findCaptureMapByLabel(maps, 'Constructor');
    expect(map).toBeDefined();
    const desc = javaDescriptionExtractor('Constructor', 'C', map!);
    expect(desc).toBe('Creates a new instance.');
  });

  it('returns undefined for unsupported labels', () => {
    const map = { 'definition.property': {} as SyntaxNode };
    const desc = javaDescriptionExtractor('Property', 'foo', map);
    expect(desc).toBeUndefined();
  });

  it('returns undefined when the capture tag is missing', () => {
    const map = { 'name': {} as SyntaxNode };
    const desc = javaDescriptionExtractor('Class', 'Foo', map);
    expect(desc).toBeUndefined();
  });
});
