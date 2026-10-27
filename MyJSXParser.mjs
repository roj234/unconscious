"use strict";

import {
  _uc_mixinPluginNames as ucBabelPluginNames,
  _uc_mixinPlugins as ucBabelPlugins,
  _uc_tokenIsKeyword as tokenIsKeyword,
  _uc_tokenLabelName as tokenLabelName,
} from "@babel/parser";

export const MIXIN_ID = "unconsciousMixin";

const TI = Object.create(null);

for (let id = 0; ; id++) {
  const current = tokenLabelName(id);
  if (current === undefined) break;
  TI[current] = id;
}

const resolveToken = label => {
  const id = TI[label];
  if (id) return id;

  throw new Error(`[unconscious] 当前 @babel/parser 中找不到 token "${label}"，可能是版本不兼容`);
};

const TT = {
  at: resolveToken('@'),
  dot: resolveToken('.'),
  parenL: resolveToken('('),
  parenR: resolveToken(')'),
  braceL: resolveToken('{'),
  braceR: resolveToken('}'),
  comma: resolveToken(','),
  jsxName: resolveToken('jsxName'),
};

ucBabelPlugins[MIXIN_ID] = superClass =>
class UnconsciousJSXParserMixin extends superClass {
  jsxParseIdentifier() {
    const node = this.startNode();

    // @
    if(this.match(TT.at)) {
      node._uc_isDecorator = true;
      this.next();
    }

    // onclick.left.passive
    if(this.match(TT.jsxName)){
      node.name = this.state.value;
      node._uc_names = [];

      this.next();
      while (this.match(TT.dot)) {
        this.next();

        if (this.match(TT.jsxName)) {
          node._uc_names.push(this.state.value);
          this.next();
        }

        // filter(...)
        if(this.match(TT.parenL)) {
          this.next();
          node._uc_names.push(this.ucparseCallExpressionArguments(TT.parenR));
        }

        // IDE fallback 语法 filter{"xx", "yy"}=...
        else if (this.match(TT.braceL)) {
          this.next();
          node._uc_names.push(this.ucparseCallExpressionArguments(TT.braceR));
        }
      }
    }
    else if(tokenIsKeyword(this.state.type)){node.name=tokenLabelName(this.state.type);
    this.next();}
    else {this.unexpected();}

    return this.finishNode(node,"JSXIdentifier");
  }

  ucparseCallExpressionArguments(stopToken = TT.parenR) {
    const elts = [];
    let first = true;
    const oldInFSharpPipelineDirectBody = this.state.inFSharpPipelineDirectBody;
    this.state.inFSharpPipelineDirectBody = false;
    while (!this.eat(stopToken)) {
      if (first) {
        first = false;
      } else {
        this.expect(TT.comma);
        if (this.match(stopToken)) {
          /*if (nodeForExtra) {
            this.addTrailingCommaExtraToNode(nodeForExtra);
          }*/
          this.next();
          break;
        }
      }
      elts.push(this.parseExprListItem(stopToken, false, /*refExpressionErrors*/undefined, /*allowPlaceholder*/undefined));
    }
    this.state.inFSharpPipelineDirectBody = oldInFSharpPipelineDirectBody;
    return elts;
  }
};
ucBabelPluginNames.push(MIXIN_ID);
