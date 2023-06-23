import Mustache from "mustache";
import { 
  AstNodeType,
  ClassDefinition,
  SdkGeneratorInput,
  SdkGeneratorInterface,
  SdkGeneratorOutput,
  TypeAlias,
  Node,
  UnionType,
  CustomAstNodeType,
  ArrayType,
  PropertyDefinition,
  Enum,
  TypeLiteral,
  StructLiteral,
  PromiseType
 } from "../../models/genezioModels";
import { TriggerType } from "../../models/yamlProjectConfiguration";
import { nodeSdkTs } from "../templates/nodeSdkTs";
import path from "path";

const TYPESCRIPT_RESERVED_WORDS = [
  "abstract",
  "as",
  "asserts",
  "async",
  "await",
  "boolean",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "constructor",
  "continue",
  "declare",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "if",
  "implements",
  "import",
  "in",
  "infer",
  "instanceof",
  "interface",
  "is",
  "keyof",
  "let",
  "module",
  "namespace",
  "never",
  "new",
  "null",
  "number",
  "object",
  "of",
  "package",
  "private",
  "protected",
  "public",
  "readonly",
  "require",
  "global",
  "return",
  "set",
  "static",
  "string",
  "super",
  "switch",
  "symbol",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "unique",
  "unknown",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "async",
  "await",
  "of"
];

const modelTemplate = `/**
* This is an auto generated code. This code should not be modified since the file can be overwriten
* if new genezio commands are executed.
*/

{{#imports}}
import { {{#models}}{{{name}}}{{^last}}, {{/last}}{{/models}} } from "./{{{path}}}";
{{/imports}}

{{#externalTypes}}
export {{{type}}}
{{/externalTypes}}
`

const template = `/**
* This is an auto generated code. This code should not be modified since the file can be overwriten
* if new genezio commands are executed.
*/

import { Remote } from "./remote";
{{#imports}}
import { {{#models}}{{{name}}}{{^last}}, {{/last}}{{/models}} } from "./{{{path}}}";
{{/imports}}

{{#externalTypes}}
export {{{type}}}
{{/externalTypes}}

export class {{{className}}} {
  static remote = new Remote("{{{_url}}}");

  {{#methods}}
  static async {{{name}}}({{#parameters}}{{{name}}}{{^last}}, {{/last}}{{/parameters}}){{{returnType}}} {
    return await {{{className}}}.remote.call({{{methodCaller}}}{{#sendParameters}}{{{name}}}{{^last}}, {{/last}}{{/sendParameters}});
  }
  {{/methods}}
}

export { Remote };
`;


class SdkGenerator implements SdkGeneratorInterface {
  async generateSdk(
    sdkGeneratorInput: SdkGeneratorInput
  ): Promise<SdkGeneratorOutput> {
    const generateSdkOutput: SdkGeneratorOutput = {
      files: []
    };

    for (const classInfo of sdkGeneratorInput.classesInfo) {
      const externalTypes: Node[] = [];
      const _url = "%%%link_to_be_replace%%%";
      const classConfiguration = classInfo.classConfiguration;

      let classDefinition: ClassDefinition | undefined = undefined;

      if (classInfo.program.body === undefined) {
        continue;
      }
      for (const elem of classInfo.program.body) {
        if (elem.type === AstNodeType.ClassDefinition) {
          classDefinition = elem as ClassDefinition;
        } else {
          externalTypes.push(elem);
        }
      }

      if (classDefinition === undefined) {
        continue;
      }

      const view: any = {
        className: classDefinition.name,
        _url: _url,
        methods: [],
        externalTypes: [],
        imports: [],
      };

      const modelViews: any = [];

      let exportClassChecker = false;

      for (const methodDefinition of classDefinition.methods) {
        const methodConfigurationType = classConfiguration.getMethodType(methodDefinition.name);

        if (methodConfigurationType !== TriggerType.jsonrpc
          || classConfiguration.type !== TriggerType.jsonrpc
        ) {
          continue;
        }

        exportClassChecker = true;

        const methodView: any = {
          name: methodDefinition.name,
          parameters: [],
          returnType: this.getReturnType(methodDefinition.returnType),
          methodCaller: methodDefinition.params.length === 0 ?
            `"${classDefinition.name}.${methodDefinition.name}"`
            : `"${classDefinition.name}.${methodDefinition.name}", `
        };

        methodView.parameters = methodDefinition.params.map((e) => {
          return {
            name: (TYPESCRIPT_RESERVED_WORDS.includes(e.name) ? e.name + "_" : e.name) + (e.optional ? "?" : "") + ": " + this.getParamType(e.paramType) + (e.defaultValue ? " = " + (e.defaultValue.type === AstNodeType.StringLiteral ? "'" + e.defaultValue.value + "'" : e.defaultValue.value) : ""),
            last: false
          }
        });

        methodView.sendParameters = methodDefinition.params.map((e) => {
          return {
            name: (TYPESCRIPT_RESERVED_WORDS.includes(e.name) ? e.name + "_" : e.name),
            last: false
          }
        });

        if (methodView.parameters.length > 0) {
          methodView.parameters[methodView.parameters.length - 1].last = true;
          methodView.sendParameters[methodView.sendParameters.length - 1].last = true;
        }

        view.methods.push(methodView);
      }

      for (const externalType of externalTypes) {
        if (externalType.path && !classInfo.classConfiguration.path.includes(externalType.path)) {
          let currentView = null;
          for (const nestedExternalType of externalTypes) {
            const isUsed = this.isExternalTypeUsed(externalType, nestedExternalType);
            if (isUsed && nestedExternalType.path && nestedExternalType.path !== externalType.path) {
              let found = false;
              for (const modelView of modelViews) {
                if (modelView.path === nestedExternalType.path) {
                  currentView = modelView;
                  found = true;
                }
              }
              if (!found) {
                currentView = {
                  path: nestedExternalType.path,
                  externalTypes: [],
                  imports: [],
                };
                modelViews.push(currentView);
              }
            }
            if (currentView) {
              let found = false;
              for (const importType of currentView.imports) {
                if (importType.path === externalType.path && !importType.models.find((e: any) => e.name === (externalType as any).name)) {
                  importType.models.push({name: (externalType as any).name});
                  importType.last = false;
                  found = true;
                  break;
                }
              }
              let relativePath = path.relative(currentView.path || ".", externalType.path || ".");
              if (relativePath.substring(0,3) == "../") {
                relativePath = relativePath.substring(3);
              }
              if (!found && !currentView.imports.find((e: any) => e.path === relativePath)) {
                currentView.imports.push({
                  path: relativePath,
                  models: [{name: (externalType as any).name}],
                  last: false
                });
              }
            }
          }
          if (!currentView) {
            let found = false;
            currentView = view;
            for (const importType of currentView.imports) {
              if (importType.path === externalType.path && !importType.models.includes((externalType as any).name)) {
                importType.models.push({name: (externalType as any).name});
                importType.last = false;
                found = true;
                break;
              }
            }
            if (!found) {
              let relativePath = path.relative(currentView.path || ".", externalType.path || ".");
              if (relativePath.substring(0,3) == "../") {
                relativePath = relativePath.substring(3);
              }
              currentView.imports.push({
                path: relativePath,
                models: [{name: (externalType as any).name}],
                last: false
              });
            }
          }

          
          let found = false;
          for (const modelView of modelViews) {
            if (modelView.path === externalType.path) {
              modelView.externalTypes.push({type: this.generateExternalType(externalType)});
              modelView.last = false;
              found = true;
              break;
            }
          }
          if (!found) {
            modelViews.push({
              path: externalType.path,
              externalTypes: [{type: this.generateExternalType(externalType)}],
              imports: [],
            });
          }
        } else {
          view.externalTypes.push({type: this.generateExternalType(externalType)});
        }
      }

      for (const modelView of modelViews) {
        for (const importType of modelView.imports) {
          importType.last = false;
          if (importType.models.length > 0) {
            importType.models[importType.models.length - 1].last = true;
          }
        }
      }

      for (const importType of view.imports) {
        importType.last = false;
        if (importType.models.length > 0) {
          importType.models[importType.models.length - 1].last = true;
        }
      }

      if (!exportClassChecker) {
        continue;
      }

      const rawSdkClassName = `${classDefinition.name}.sdk.ts`;
      const sdkClassName = rawSdkClassName.charAt(0).toLowerCase() + rawSdkClassName.slice(1)

      generateSdkOutput.files.push({
        path: sdkClassName,
        data: Mustache.render(template, view),
        className: classDefinition.name
      });


      for (const modelView of modelViews) {
        generateSdkOutput.files.push({
          path: modelView.path + ".ts",
          data: Mustache.render(modelTemplate, modelView),
          className: ''
        });
      }
    }

    // generate remote.js
    generateSdkOutput.files.push({
      className: "Remote",
      path: "remote.ts",
      data: nodeSdkTs.replace("%%%url%%%", "undefined")
    });

    return generateSdkOutput;
  }

  getReturnType(returnType: Node): string {
    if (!returnType || returnType.type === AstNodeType.VoidLiteral) {
      return "";
    }

    let value = this.getParamType(returnType);
    if (returnType.type !== AstNodeType.PromiseType) {
      value = `Promise<${value}>`;
    }

    return `: ${value}`;
  }

  getParamType(elem: Node): string {
    if (elem.type === AstNodeType.CustomNodeLiteral) {
      return (elem as CustomAstNodeType).rawValue;
    } else if (elem.type === AstNodeType.StringLiteral) {
      return "string";
    } else if (elem.type === AstNodeType.IntegerLiteral || elem.type === AstNodeType.FloatLiteral || elem.type === AstNodeType.DoubleLiteral) {
      return "number";
    } else if (elem.type === AstNodeType.BooleanLiteral) {
      return "boolean";
    } else if (elem.type === AstNodeType.AnyLiteral) {
      return "any";
    } else if (elem.type === AstNodeType.ArrayType) {
      return `Array<${this.getParamType((elem as ArrayType).generic)}>`;
    } else if (elem.type === AstNodeType.PromiseType) {
      return `Promise<${this.getParamType((elem as PromiseType).generic)}>`;
    } else if (elem.type === AstNodeType.Enum) {
      return (elem as Enum).name;
    } else if (elem.type === AstNodeType.TypeAlias) {
      return (elem as TypeAlias).name;
    } else if (elem.type === AstNodeType.UnionType) {
      return (elem as UnionType).params
        .map((e: Node) => this.getParamType(e))
        .join(" | ");
    } else if (elem.type === AstNodeType.TypeLiteral) {
      return `{${(elem as TypeLiteral).properties.map((e: PropertyDefinition) => `${e.name}${e.optional ? '?' : ''}: ${this.getParamType(e.type)}`).join(", ")}}`;
    } else if (elem.type === AstNodeType.DateType) {
      return "Date";
    }
    return "any";
  }

  generateExternalType(type: Node): string {
    if (type.type === AstNodeType.TypeAlias) {
      const typeAlias = type as TypeAlias;
      return `type ${typeAlias.name} = ${this.getParamType(typeAlias.aliasType)};`;
    } else if (type.type === AstNodeType.Enum) {
      const enumType = type as Enum;
      return `enum ${enumType.name} {${enumType.cases.map((c) => {
        if (c.type === AstNodeType.StringLiteral) {
          return `${c.name} = "${c.value}"`;
        } else if (c.type === AstNodeType.DoubleLiteral) {
          if (c.value !== undefined && c.value !== null) {
            return `${c.name} = ${c.value}`;
          } else {
            return `${c.name}`;
          }
        }
      }).join(", ")}}`;
    } else if (type.type === AstNodeType.StructLiteral) {
      const typeAlias = type as StructLiteral;
      return `type ${typeAlias.name} = ${this.getParamType(typeAlias.typeLiteral)};`;
    }
    return "";
  }

  isExternalTypeUsed(externalType: Node, type: Node): boolean {
    if (type.type === AstNodeType.TypeAlias) {
      const typeAlias = type as TypeAlias;
      return this.isExternalTypeUsed(externalType, typeAlias.aliasType);
    } else if (type.type === AstNodeType.Enum) {
      return false;
    } else if (type.type === AstNodeType.StructLiteral) {
      const typeAlias = type as StructLiteral;
      return this.isExternalTypeUsed(externalType, typeAlias.typeLiteral);
    } else if (type.type === AstNodeType.ArrayType) {
      return this.isExternalTypeUsed(externalType, (type as ArrayType).generic);
    } else if (type.type === AstNodeType.PromiseType) {
      return this.isExternalTypeUsed(externalType, (type as PromiseType).generic);
    } else if (type.type === AstNodeType.UnionType) {
      return (type as UnionType).params.some((e: Node) => this.isExternalTypeUsed(externalType, e));
    } else if (type.type === AstNodeType.TypeLiteral) {
      return (type as TypeLiteral).properties.some((e: PropertyDefinition) => this.isExternalTypeUsed(externalType, e.type));
    } else if (type.type === AstNodeType.DateType) {
      return false;
    } else if (type.type === AstNodeType.CustomNodeLiteral) {
      if ((type as CustomAstNodeType).rawValue === (externalType as any).name) {
        return true;
      }
      return false;
    } else if (type.type === AstNodeType.StringLiteral) {
      return false;
    } else if (type.type === AstNodeType.IntegerLiteral || type.type === AstNodeType.FloatLiteral || type.type === AstNodeType.DoubleLiteral) {
      return false;
    } else if (type.type === AstNodeType.BooleanLiteral) {
      return false;
    } else if (type.type === AstNodeType.AnyLiteral) {
      return false;
    }
    return false;
  }
}


const supportedLanguages = ["ts", "typescript"];


export default { SdkGenerator, supportedLanguages }