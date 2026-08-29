// ── Node type constants ──────────────────────────────────────────

export const ELEMENT: 'element';
export const TEXT: 'text';
export const COMMENT: 'comment';
export const CDATA: 'cdata';
export const PI: 'pi';

// ── Node types ───────────────────────────────────────────────────

export interface ElementNode {
  type: 'element';
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export interface TextNode {
  type: 'text';
  content: string;
}

export interface CommentNode {
  type: 'comment';
  content: string;
}

export interface CDataNode {
  type: 'cdata';
  content: string;
}

export interface PINode {
  type: 'pi';
  target: string;
  data: string;
}

export type XmlNode = ElementNode | TextNode | CommentNode | CDataNode | PINode;

// ── Parser handler callbacks ─────────────────────────────────────

export interface XmlParserHandlers {
  /** Called when an opening tag (or self-closing tag) is encountered */
  onOpenTag(name: string, attrs: Record<string, string>, isSelfClosing: boolean): void;
  /** Called when a closing tag is encountered */
  onCloseTag(name: string): void;
  /** Called for text content between tags */
  onText(text: string): void;
  /** Optional: called for XML comments */
  onComment?(text: string): void;
  /** Optional: called for processing instructions (e.g. <?xml ...?>) */
  onPI?(target: string, data: string): void;
  /** Optional: called for CDATA sections */
  onCData?(text: string): void;
}

export interface XmlParserOptions {
  /** Whether to decode XML entities (e.g. &amp; → &). Default: `true` */
  decodeEntities?: boolean;
  html?: boolean;
  voidTags?: Set<string>;
  textTags?: Set<string>;
}

export interface XmlParser {
  /** Feed a chunk of XML text to the parser */
  write(chunk: string): void;
  /** Signal end of input; flushes any pending text and closes remaining tags */
  end(): void;
  /** Returns a copy of the current open-tag stack (for debugging) */
  getStack(): string[];
}

// ── Tree-building options ────────────────────────────────────────

export interface ParseXmlTreeOptions extends XmlParserOptions {
  /** Whether to include processing instruction nodes. Default: `false` */
  includePI?: boolean;
  /** Whether to include comment nodes. Default: `false` */
  includeComments?: boolean;
}

// ── API functions ────────────────────────────────────────────────

/**
 * Create a streaming XML parser.
 *
 * @param handlers - Callback object for XML events
 * @param options  - Parser options
 */
export function createXmlParser(
  handlers: XmlParserHandlers,
  options?: XmlParserOptions,
): XmlParser;

/**
 * Parse an XML string into a tree of plain-object nodes.
 *
 * If the input contains exactly one root element, that element is returned directly.
 * Otherwise, a synthetic `#root` element wrapping all top-level nodes is returned.
 *
 * @param xml     - XML string to parse
 * @param options - Tree-building options
 * @returns The root element node
 */
export function parseXmlToTree(
  xml: string,
  options?: ParseXmlTreeOptions,
): ElementNode;
