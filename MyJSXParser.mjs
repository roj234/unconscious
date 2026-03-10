"use strict";

import {
  _uc_mixinPluginNames as ucBabelPluginNames,
  _uc_mixinPlugins as ucBabelPlugins,
  _uc_tokenIsKeyword as tokenIsKeyword,
  _uc_tokenLabelName as tokenLabelName,
} from "@babel/parser";

export const MIXIN_ID = "unconsciousMixin";

ucBabelPlugins[MIXIN_ID] = superClass =>
class UnconsciousJSXParserMixin extends superClass {
  jsxParseIdentifier() {
    const node = this.startNode();

    // @
    if(this.match(26)) {
      node._uc_isDecorator = true;
      this.next();
    }

    // onclick.left.passive
    if(this.match(141)){
      node.name = this.state.value;
      node._uc_names = [];

      this.next();
      while (this.match(16)) {
        this.next();

        if (this.match(141)) {
          node._uc_names.push(this.state.value);
          this.next();
        }

        // filter(...)
        if(this.match(10)) {
          this.next();
          node._uc_names.push(this.ucparseCallExpressionArguments(11));
        }

        // IDE fallback 语法 filter{"xx", "yy"}=...
        else if (this.match(5)) {
          this.next();
          node._uc_names.push(this.ucparseCallExpressionArguments(8));
        }
      }
    }
    else if(tokenIsKeyword(this.state.type)){node.name=tokenLabelName(this.state.type);
    this.next();}
    else {this.unexpected();}

    return this.finishNode(node,"JSXIdentifier");
  }

  ucparseCallExpressionArguments(stopToken = 11) {
    const elts = [];
    let first = true;
    const oldInFSharpPipelineDirectBody = this.state.inFSharpPipelineDirectBody;
    this.state.inFSharpPipelineDirectBody = false;
    while (!this.eat(stopToken)) {
      if (first) {
        first = false;
      } else {
        this.expect(12);
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
