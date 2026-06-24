/**
 * Java language provider.
 *
 * Java uses named imports, JVM wildcard/member import resolution,
 * and a 'public' modifier-based export checker. Heritage uses
 * EXTENDS by default with implements-split MRO for multiple
 * interface implementation.
 */

import { SupportedLanguages, type NodeLabel } from 'gitnexus-shared';
import type { CaptureMap } from '../language-provider.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import { createClassExtractor } from '../class-extractors/generic.js';
import { javaClassConfig } from '../class-extractors/configs/jvm.js';
import { defineLanguage } from '../language-provider.js';
import type { AstFrameworkPatternConfig } from '../language-provider.js';
import { javaTypeConfig } from '../type-extractors/jvm.js';
import { extractSpringRoutes } from '../route-extractors/spring.js';
import { javaExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { javaImportConfig } from '../import-resolvers/configs/jvm.js';
import { JAVA_QUERIES } from '../tree-sitter-queries.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { javaCallConfig } from '../call-extractors/configs/jvm.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { javaConfig } from '../field-extractors/configs/jvm.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { javaMethodConfig } from '../method-extractors/configs/jvm.js';
import { createVariableExtractor } from '../variable-extractors/generic.js';
import { javaVariableConfig } from '../variable-extractors/configs/jvm.js';
import { createJavaCfgVisitor } from '../cfg/visitors/java.js';
import type { SymbolDefinition } from 'gitnexus-shared';
import {
  emitJavaScopeCaptures,
  interpretJavaImport,
  interpretJavaTypeBinding,
  javaBindingScopeFor,
  javaImportOwningScope,
  javaMergeBindings,
  javaReceiverBinding,
  javaArityCompatibility,
  resolveJavaImportTarget,
} from './java/index.js';

/**
 * Extract Javadoc / KDoc description from the nearest preceding block comment.
 *
 * Walks `previousSibling` from the definition node, stopping at the first
 * contiguous run of `block_comment` nodes that begins with `/**`. Stops
 * earlier if a non-comment named sibling is encountered (mirrors the Ruby
 * YARD extractor in call-routing.ts).
 */
export function extractJavaDocComment(definitionNode: SyntaxNode): string | undefined {
  let sibling = definitionNode.previousSibling;
  const lines: string[] = [];

  while (sibling) {
    if (sibling.type === 'block_comment') {
      const text = sibling.text;
      if (text.startsWith('/**')) {
        lines.unshift(text);
        // A single Javadoc is one block_comment node; stop here.
        break;
      }
      sibling = sibling.previousSibling;
      continue;
    }
    if (sibling.isNamed) {
      // Stop at any named non-comment sibling (e.g., another method,
      // field, or annotation). We don't want to walk across unrelated
      // definitions.
      break;
    }
    sibling = sibling.previousSibling;
  }

  if (lines.length === 0) return undefined;

  const raw = lines.join('\n');

  // Strip `/**` prefix and `*/` suffix, then process each line.
  const inner = raw
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '');

  const processed = inner
    .split('\n')
    .map((line) => {
      // Strip leading `*` and whitespace from each line.
      const stripped = line.replace(/^\s*\*\s?/, '');
      return stripped.trim();
    })
    .filter((line) => line.length > 0);

  // Stop at the first `@` tag line (e.g., `@param`, `@return`) so only
  // the human-readable summary is captured.
  const firstNonTagIndex = processed.findIndex((line) => !line.startsWith('@'));
  if (firstNonTagIndex === -1) return undefined;
  // Take all lines from the first non-tag up to (but not including) the first tag.
  const summaryLines = processed.slice(firstNonTagIndex);
  const firstTagAfter = summaryLines.findIndex((line) => line.startsWith('@'));
  const descriptionLines = firstTagAfter === -1 ? summaryLines : summaryLines.slice(0, firstTagAfter);

  const normalized = descriptionLines
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return undefined;

  // Cap at the embedding pipeline's default max description length.
  const MAX_DESC = 150;
  return normalized.length > MAX_DESC ? normalized.slice(0, MAX_DESC) : normalized;
}

export function javaDescriptionExtractor(
  nodeLabel: NodeLabel,
  _nodeName: string,
  captureMap: CaptureMap,
): string | undefined {
  // Map node labels to the capture tag names used in JAVA_QUERIES.
  const tagByLabel: Record<string, string> = {
    Class: 'definition.class',
    Interface: 'definition.interface',
    Enum: 'definition.enum',
    Method: 'definition.method',
    Constructor: 'definition.constructor',
  };

  const tag = tagByLabel[nodeLabel];
  if (!tag) return undefined;

  const node = captureMap[tag];
  if (!node) return undefined;

  return extractJavaDocComment(node);
}

const orderJavaSameNameTypeCandidates = ({
  callSiteFilePath,
  candidates,
}: {
  readonly typeName: string;
  readonly callSiteFilePath: string;
  readonly candidates: readonly SymbolDefinition[];
}): readonly SymbolDefinition[] | null => {
  if (!callSiteFilePath.endsWith('.java')) return null;
  if (candidates.length <= 1) return null;
  const callerDir = splitDirectorySegments(callSiteFilePath);

  const scored = candidates.map((candidate, index) => ({
    candidate,
    index,
    score: sharedPrefixLength(callerDir, splitDirectorySegments(candidate.filePath)),
  }));
  const bestScore = Math.max(...scored.map((entry) => entry.score));
  // When all candidates tie, we have no structural signal to prefer one path.
  // Returning null keeps downstream ambiguity handling conservative.
  if (scored.every((entry) => entry.score === bestScore)) return null;

  const ordered = [...scored]
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.candidate);
  return ordered;
};

const splitDirectorySegments = (filePath: string): string[] => {
  const normalized = filePath.replace(/\\/g, '/');
  // Remove empty segments from leading/trailing/multiple slashes, then drop filename.
  const segments = normalized.split('/').filter(Boolean);
  return segments.slice(0, -1);
};

const sharedPrefixLength = (left: readonly string[], right: readonly string[]): number => {
  const max = Math.min(left.length, right.length);
  let idx = 0;
  while (idx < max && left[idx] === right[idx]) idx += 1;
  return idx;
};

export const javaProvider = defineLanguage({
  id: SupportedLanguages.Java,
  extensions: ['.java'],
  entryPointPatterns: [/^do[A-Z]/, /^create[A-Z]/, /^build[A-Z]/, /Service$/],
  astFrameworkPatterns: [
    {
      framework: 'spring',
      entryPointMultiplier: 3.2,
      reason: 'spring-annotation',
      patterns: [
        '@RestController',
        '@Controller',
        '@GetMapping',
        '@PostMapping',
        '@RequestMapping',
      ],
    },
    {
      framework: 'jaxrs',
      entryPointMultiplier: 3.0,
      reason: 'jaxrs-annotation',
      patterns: ['@Path', '@GET', '@POST', '@PUT', '@DELETE'],
    },
  ] satisfies AstFrameworkPatternConfig[],
  treeSitterQueries: JAVA_QUERIES,
  typeConfig: javaTypeConfig,
  exportChecker: javaExportChecker,
  importResolver: createImportResolver(javaImportConfig),
  mroStrategy: 'implements-split',
  callExtractor: createCallExtractor(javaCallConfig),
  fieldExtractor: createFieldExtractor(javaConfig),
  methodExtractor: createMethodExtractor(javaMethodConfig),
  variableExtractor: createVariableExtractor(javaVariableConfig),
  classExtractor: createClassExtractor(javaClassConfig),
  descriptionExtractor: javaDescriptionExtractor,

  // ── RFC #909 Ring 3: scope-based resolution hooks ──
  emitScopeCaptures: emitJavaScopeCaptures,

  // ── PDG: per-function CFG + def/use harvest (#2195 U4) ──
  cfgVisitor: createJavaCfgVisitor(),
  interpretImport: interpretJavaImport,
  interpretTypeBinding: interpretJavaTypeBinding,
  bindingScopeFor: javaBindingScopeFor,
  importOwningScope: javaImportOwningScope,
  mergeBindings: (_scope, bindings) => javaMergeBindings(bindings),
  receiverBinding: javaReceiverBinding,
  arityCompatibility: javaArityCompatibility,
  resolveImportTarget: resolveJavaImportTarget,
  orderSameNameTypeCandidates: orderJavaSameNameTypeCandidates,

  // ── Route extraction ──
  extractDecoratorRoutes: extractSpringRoutes,
});
