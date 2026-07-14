/**
 * Revision-1 SYQL module/name/signature semantics (§§4–8).
 *
 * This pass deliberately runs before SQLite/schema analysis. It resolves and
 * expands predicates using token nodes, proves authoritative query inputs and
 * `when` dominance, and produces a backend-neutral logical template.
 */
import {
  SyqlFrontendError,
  type SyqlSourceSpan,
  type SyqlToken,
} from './syql-lexer';
import type { SyqlModuleGraph } from './syql-modules';
import type {
  SyqlPredicateDeclaration,
  SyqlQueryDeclaration,
  SyqlQueryParameter,
  SyqlSyntaxFile,
  SyqlValueType,
} from './syql-parser';
import type {
  SyqlEmbeddedNode,
  SyqlEmbeddedTemplate,
  SyqlPredicateCall,
  SyqlReactiveDirective,
} from './syql-template-parser';

export type SyqlSemanticErrorCode =
  | 'SYQL5001_UNKNOWN_PREDICATE'
  | 'SYQL5002_PREDICATE_CYCLE'
  | 'SYQL5003_PREDICATE_ARITY'
  | 'SYQL5004_CLOSED_PREDICATE'
  | 'SYQL5005_UNUSED_PREDICATE_PARAMETER'
  | 'SYQL5006_UNDECLARED_BIND'
  | 'SYQL5007_UNUSED_INPUT'
  | 'SYQL5008_INVALID_CONTROL'
  | 'SYQL5009_MISSING_DOMINANCE'
  | 'SYQL5010_UNUSED_CONTROL'
  | 'SYQL5011_TYPE_CONFLICT';

export interface SyqlResolvedPredicate {
  readonly id: string;
  readonly module: SyqlSyntaxFile;
  readonly declaration: SyqlPredicateDeclaration;
}

export interface SyqlLogicalBind {
  readonly kind: 'bind';
  readonly name: string;
  readonly span: SyqlSourceSpan;
  /** Outermost call-site first, authored bind last. */
  readonly origins: readonly SyqlSourceSpan[];
}

export type SyqlSqlPart =
  | { readonly kind: 'text'; readonly text: string }
  | SyqlLogicalBind;

export interface SyqlLogicalSqlNode {
  readonly kind: 'sql';
  readonly parts: readonly SyqlSqlPart[];
  readonly span: SyqlSourceSpan;
}

export interface SyqlLogicalPredicateNode {
  readonly kind: 'predicate';
  readonly predicate: SyqlResolvedPredicate;
  readonly body: readonly SyqlLogicalTemplateNode[];
  readonly span: SyqlSourceSpan;
}

export interface SyqlLogicalWhenNode {
  readonly kind: 'when';
  readonly controls: readonly string[];
  readonly controlSpans: readonly SyqlSourceSpan[];
  readonly body: readonly SyqlLogicalTemplateNode[];
  readonly span: SyqlSourceSpan;
}

export interface SyqlLogicalReactiveNode {
  readonly kind: 'scope' | 'cover';
  readonly directive: SyqlReactiveDirective;
  readonly span: SyqlSourceSpan;
}

export type SyqlLogicalTemplateNode =
  | SyqlLogicalSqlNode
  | SyqlLogicalPredicateNode
  | SyqlLogicalWhenNode
  | SyqlLogicalReactiveNode;

export interface SyqlLogicalInput {
  readonly parameter: SyqlQueryParameter;
  /** Type declared in source or constrained by annotated predicate formals. */
  readonly type?: SyqlValueType;
}

export interface SyqlLogicalQuery {
  readonly module: SyqlSyntaxFile;
  readonly declaration: SyqlQueryDeclaration;
  readonly inputs: readonly SyqlLogicalInput[];
  readonly template: readonly SyqlLogicalTemplateNode[];
  readonly conditions: readonly SyqlLogicalWhenNode[];
  /** Resolved source/predicate types by scalar or group-member bind name. */
  readonly bindTypes: ReadonlyMap<string, SyqlValueType>;
}

export interface SyqlSemanticProgram {
  readonly graph: SyqlModuleGraph;
  readonly predicateScopes: ReadonlyMap<
    string,
    ReadonlyMap<string, SyqlResolvedPredicate>
  >;
  readonly predicates: readonly SyqlResolvedPredicate[];
  readonly queries: readonly SyqlLogicalQuery[];
}

interface ActualBind {
  readonly name: string;
  readonly span: SyqlSourceSpan;
  readonly origins: readonly SyqlSourceSpan[];
}

interface QueryBindSymbol {
  readonly name: string;
  readonly parameter: SyqlQueryParameter;
  readonly controller?: string;
  readonly type?: SyqlValueType;
  readonly span: SyqlSourceSpan;
}

interface ExpansionContext {
  readonly queryBinds?: ReadonlyMap<string, QueryBindSymbol>;
  readonly requirements?: Map<string, SyqlValueType[]>;
}

function predicateId(file: string, name: string): string {
  return `${file}\0${name}`;
}

function bindName(token: SyqlToken): string {
  return token.text.slice(1);
}

function typeText(type: SyqlValueType): string {
  return `${type.base}${type.nullable ? ' | null' : ''}`;
}

function isCompatible(actual: SyqlValueType, formal: SyqlValueType): boolean {
  return actual.base === formal.base && (!actual.nullable || formal.nullable);
}

class SemanticAnalyzer {
  readonly #graph: SyqlModuleGraph;
  readonly #predicateById = new Map<string, SyqlResolvedPredicate>();
  readonly #scopes = new Map<string, Map<string, SyqlResolvedPredicate>>();
  readonly #calls = new Map<string, readonly SyqlResolvedPredicate[]>();
  readonly #usedPredicateParams = new Map<string, ReadonlySet<string>>();

  constructor(graph: SyqlModuleGraph) {
    this.#graph = graph;
  }

  analyze(): SyqlSemanticProgram {
    this.#buildScopes();
    this.#resolvePredicateCalls();
    this.#checkPredicateCycles();
    this.#checkPredicateTypes();
    this.#checkPredicateClosureAndUse();

    const queries = this.#graph.modules.flatMap((module) =>
      module.queries.map((query) => this.#analyzeQuery(module, query)),
    );
    return {
      graph: this.#graph,
      predicateScopes: this.#scopes,
      predicates: [...this.#predicateById.values()],
      queries,
    };
  }

  #buildScopes(): void {
    for (const module of this.#graph.modules) {
      const scope = new Map<string, SyqlResolvedPredicate>();
      for (const declaration of module.predicates) {
        const resolved = {
          id: predicateId(module.file, declaration.name),
          module,
          declaration,
        };
        this.#predicateById.set(resolved.id, resolved);
        scope.set(declaration.name, resolved);
      }
      this.#scopes.set(module.file, scope);
    }

    for (const edge of this.#graph.edges) {
      const scope = this.#scopes.get(edge.from) as Map<
        string,
        SyqlResolvedPredicate
      >;
      for (const item of edge.declaration.items) {
        const target = this.#predicateById.get(
          predicateId(edge.to, item.imported),
        ) as SyqlResolvedPredicate;
        scope.set(item.local, target);
      }
    }
  }

  #resolvePredicateCalls(): void {
    for (const predicate of this.#predicateById.values()) {
      const calls: SyqlResolvedPredicate[] = [];
      for (const node of predicate.declaration.body.tree.nodes) {
        if (node.kind !== 'predicate-call') continue;
        const target = this.#resolveCall(
          predicate.module,
          node.name,
          node.span,
        );
        this.#checkArity(node.arguments.length, target, node.span);
        calls.push(target);
      }
      this.#calls.set(predicate.id, calls);
    }
  }

  #checkPredicateCycles(): void {
    const states = new Map<string, 'active' | 'complete'>();
    const stack: SyqlResolvedPredicate[] = [];

    const visit = (predicate: SyqlResolvedPredicate): void => {
      const state = states.get(predicate.id);
      if (state === 'complete') return;
      if (state === 'active') {
        const start = stack.findIndex((item) => item.id === predicate.id);
        const cycle = [...stack.slice(start), predicate]
          .map((item) => `${item.declaration.name} (${item.module.file})`)
          .join(' -> ');
        this.#fail(
          'SYQL5002_PREDICATE_CYCLE',
          predicate.declaration.nameSpan,
          `predicate call cycle: ${cycle}`,
        );
      }
      states.set(predicate.id, 'active');
      stack.push(predicate);
      for (const target of this.#calls.get(predicate.id) ?? []) visit(target);
      stack.pop();
      states.set(predicate.id, 'complete');
    };

    for (const predicate of this.#predicateById.values()) visit(predicate);
  }

  #checkPredicateClosureAndUse(): void {
    for (const predicate of this.#predicateById.values()) {
      const declared = new Set(
        predicate.declaration.parameters.map((parameter) => parameter.name),
      );
      for (const node of predicate.declaration.body.tree.nodes) {
        if (node.kind === 'raw') {
          for (const token of node.tokens) {
            if (token.kind === 'bind' && !declared.has(bindName(token))) {
              this.#fail(
                'SYQL5004_CLOSED_PREDICATE',
                token.span,
                `predicate ${predicate.declaration.name} uses undeclared bind ${token.text}`,
              );
            }
          }
        } else if (node.kind === 'predicate-call') {
          for (const argument of node.arguments) {
            if (!declared.has(argument.name)) {
              this.#fail(
                'SYQL5004_CLOSED_PREDICATE',
                argument.span,
                `predicate ${predicate.declaration.name} passes undeclared bind :${argument.name}`,
              );
            }
          }
        }
      }
    }

    const computeUsed = (
      predicate: SyqlResolvedPredicate,
    ): ReadonlySet<string> => {
      const cached = this.#usedPredicateParams.get(predicate.id);
      if (cached !== undefined) return cached;
      const used = new Set<string>();
      const scope = this.#scopes.get(predicate.module.file) as ReadonlyMap<
        string,
        SyqlResolvedPredicate
      >;
      for (const node of predicate.declaration.body.tree.nodes) {
        if (node.kind === 'raw') {
          for (const token of node.tokens) {
            if (token.kind === 'bind') used.add(bindName(token));
          }
        } else if (node.kind === 'predicate-call') {
          const target = scope.get(node.name) as SyqlResolvedPredicate;
          const targetUsed = computeUsed(target);
          target.declaration.parameters.forEach((formal, index) => {
            if (targetUsed.has(formal.name)) {
              const actual = node.arguments[index];
              if (actual !== undefined) used.add(actual.name);
            }
          });
        }
      }
      this.#usedPredicateParams.set(predicate.id, used);
      return used;
    };

    for (const predicate of this.#predicateById.values()) {
      const used = computeUsed(predicate);
      for (const parameter of predicate.declaration.parameters) {
        if (!used.has(parameter.name)) {
          this.#fail(
            'SYQL5005_UNUSED_PREDICATE_PARAMETER',
            parameter.nameSpan,
            `predicate parameter ${parameter.name} is unused after expansion`,
          );
        }
      }
    }
  }

  #checkPredicateTypes(): void {
    const cache = new Map<
      string,
      ReadonlyMap<string, readonly SyqlValueType[]>
    >();

    const constraintsFor = (
      predicate: SyqlResolvedPredicate,
    ): ReadonlyMap<string, readonly SyqlValueType[]> => {
      const cached = cache.get(predicate.id);
      if (cached !== undefined) return cached;
      const constraints = new Map<string, SyqlValueType[]>();
      for (const parameter of predicate.declaration.parameters) {
        if (parameter.type !== undefined) {
          constraints.set(parameter.name, [parameter.type]);
        }
      }
      const scope = this.#scopes.get(predicate.module.file) as ReadonlyMap<
        string,
        SyqlResolvedPredicate
      >;
      for (const node of predicate.declaration.body.tree.nodes) {
        if (node.kind !== 'predicate-call') continue;
        const target = scope.get(node.name) as SyqlResolvedPredicate;
        const targetConstraints = constraintsFor(target);
        target.declaration.parameters.forEach((formal, index) => {
          const actual = node.arguments[index];
          if (actual === undefined) return;
          const propagated = targetConstraints.get(formal.name) ?? [];
          const list = constraints.get(actual.name) ?? [];
          list.push(...propagated);
          constraints.set(actual.name, list);
        });
      }

      for (const parameter of predicate.declaration.parameters) {
        const list = constraints.get(parameter.name) ?? [];
        const first = list[0];
        if (first !== undefined) {
          for (const constraint of list.slice(1)) {
            if (constraint.base !== first.base) {
              this.#fail(
                'SYQL5011_TYPE_CONFLICT',
                parameter.nameSpan,
                `predicate parameter ${parameter.name} is constrained as both ${typeText(first)} and ${typeText(constraint)}`,
              );
            }
          }
        }
        if (parameter.type !== undefined) {
          for (const constraint of list) {
            if (!isCompatible(parameter.type, constraint)) {
              this.#fail(
                'SYQL5011_TYPE_CONFLICT',
                parameter.nameSpan,
                `predicate parameter ${parameter.name} has type ${typeText(parameter.type)}, incompatible with nested predicate formal ${typeText(constraint)}`,
              );
            }
          }
        }
      }
      cache.set(predicate.id, constraints);
      return constraints;
    };

    for (const predicate of this.#predicateById.values()) {
      constraintsFor(predicate);
    }
  }

  #analyzeQuery(
    module: SyqlSyntaxFile,
    query: SyqlQueryDeclaration,
  ): SyqlLogicalQuery {
    const bindSymbols = this.#queryBindSymbols(query);
    const requirements = new Map<string, SyqlValueType[]>();
    const template = this.#expandTemplate(
      module,
      query.sql.body.tree,
      new Map(),
      { queryBinds: bindSymbols, requirements },
    );
    const conditions: SyqlLogicalWhenNode[] = [];
    this.#collectConditions(template, conditions);
    this.#validateControls(query, conditions);
    this.#validateBindsAndDominance(query, bindSymbols, template, conditions);
    const resolvedTypes = this.#resolveTypeRequirements(
      bindSymbols,
      requirements,
    );
    return {
      module,
      declaration: query,
      inputs: query.parameters.map((parameter) => {
        const type = this.#parameterType(parameter, resolvedTypes);
        return { parameter, ...(type === undefined ? {} : { type }) };
      }),
      template,
      conditions,
      bindTypes: resolvedTypes,
    };
  }

  #queryBindSymbols(
    query: SyqlQueryDeclaration,
  ): ReadonlyMap<string, QueryBindSymbol> {
    const symbols = new Map<string, QueryBindSymbol>();
    for (const parameter of query.parameters) {
      if (parameter.kind === 'switch') continue;
      if (parameter.kind === 'group') {
        for (const member of parameter.members) {
          symbols.set(member.name, {
            name: member.name,
            parameter,
            controller: parameter.name,
            ...(member.type === undefined ? {} : { type: member.type }),
            span: member.nameSpan,
          });
        }
      } else {
        symbols.set(parameter.name, {
          name: parameter.name,
          parameter,
          ...(parameter.optional ? { controller: parameter.name } : {}),
          ...(parameter.type === undefined ? {} : { type: parameter.type }),
          span: parameter.nameSpan,
        });
      }
    }
    return symbols;
  }

  #expandTemplate(
    module: SyqlSyntaxFile,
    template: SyqlEmbeddedTemplate,
    substitution: ReadonlyMap<string, ActualBind>,
    context: ExpansionContext,
  ): readonly SyqlLogicalTemplateNode[] {
    return template.nodes.map((node) =>
      this.#expandNode(module, node, substitution, context),
    );
  }

  #expandNode(
    module: SyqlSyntaxFile,
    node: SyqlEmbeddedNode,
    substitution: ReadonlyMap<string, ActualBind>,
    context: ExpansionContext,
  ): SyqlLogicalTemplateNode {
    if (node.kind === 'raw') {
      const parts: SyqlSqlPart[] = [];
      for (const token of node.tokens) {
        if (token.kind !== 'bind') {
          const previous = parts[parts.length - 1];
          if (previous?.kind === 'text') {
            parts[parts.length - 1] = {
              kind: 'text',
              text: previous.text + token.text,
            };
          } else {
            parts.push({ kind: 'text', text: token.text });
          }
          continue;
        }
        const authored = bindName(token);
        const substituted = substitution.get(authored);
        parts.push({
          kind: 'bind',
          name: substituted?.name ?? authored,
          span: token.span,
          origins:
            substituted === undefined
              ? [token.span]
              : [...substituted.origins, token.span],
        });
      }
      return { kind: 'sql', parts, span: node.span };
    }
    if (node.kind === 'when') {
      return {
        kind: 'when',
        controls: node.controls,
        controlSpans: node.controlSpans,
        body: this.#expandTemplate(module, node.body, substitution, context),
        span: node.span,
      };
    }
    if (node.kind === 'scope' || node.kind === 'cover') {
      return { kind: node.kind, directive: node, span: node.span };
    }
    const call = node as SyqlPredicateCall;
    const target = this.#resolveCall(module, call.name, call.span);
    this.#checkArity(call.arguments.length, target, call.span);
    const targetSubstitution = new Map<string, ActualBind>();
    target.declaration.parameters.forEach((formal, index) => {
      const argument = call.arguments[index] as (typeof call.arguments)[number];
      const outer = substitution.get(argument.name);
      const actual: ActualBind = outer ?? {
        name: argument.name,
        span: argument.span,
        origins: [argument.span],
      };
      targetSubstitution.set(formal.name, actual);
      if (formal.type !== undefined && context.requirements !== undefined) {
        const list = context.requirements.get(actual.name) ?? [];
        list.push(formal.type);
        context.requirements.set(actual.name, list);
      }
    });
    return {
      kind: 'predicate',
      predicate: target,
      body: this.#expandTemplate(
        target.module,
        target.declaration.body.tree,
        targetSubstitution,
        context,
      ),
      span: call.span,
    };
  }

  #collectConditions(
    nodes: readonly SyqlLogicalTemplateNode[],
    out: SyqlLogicalWhenNode[],
  ): void {
    for (const node of nodes) {
      if (node.kind === 'when') out.push(node);
      else if (node.kind === 'predicate')
        this.#collectConditions(node.body, out);
    }
  }

  #validateControls(
    query: SyqlQueryDeclaration,
    conditions: readonly SyqlLogicalWhenNode[],
  ): void {
    const controls = new Map(query.parameters.map((item) => [item.name, item]));
    for (const condition of conditions) {
      condition.controls.forEach((name, index) => {
        const parameter = controls.get(name);
        if (parameter === undefined) {
          this.#fail(
            'SYQL5008_INVALID_CONTROL',
            condition.controlSpans[index] as SyqlSourceSpan,
            `unknown when control ${JSON.stringify(name)}`,
          );
        }
        if (parameter.kind === 'value' && !parameter.optional) {
          this.#fail(
            'SYQL5008_INVALID_CONTROL',
            condition.controlSpans[index] as SyqlSourceSpan,
            `required scalar ${name} cannot control when; only optional values, groups, and switches can`,
          );
        }
      });
    }
  }

  #validateBindsAndDominance(
    query: SyqlQueryDeclaration,
    symbols: ReadonlyMap<string, QueryBindSymbol>,
    template: readonly SyqlLogicalTemplateNode[],
    conditions: readonly SyqlLogicalWhenNode[],
  ): void {
    const allUses = new Map<string, SyqlLogicalBind[]>();
    const controlledUses = new Map<string, Set<string>>();
    const usedControls = new Set<string>();

    const record = (
      bind: SyqlLogicalBind,
      active: ReadonlySet<string>,
    ): void => {
      const symbol = symbols.get(bind.name);
      if (symbol === undefined) {
        this.#fail(
          'SYQL5006_UNDECLARED_BIND',
          bind.span,
          `bind :${bind.name} is not declared by query ${query.name}`,
        );
      }
      const uses = allUses.get(bind.name) ?? [];
      uses.push(bind);
      allUses.set(bind.name, uses);
      if (symbol.controller !== undefined) {
        if (!active.has(symbol.controller)) {
          this.#fail(
            'SYQL5009_MISSING_DOMINANCE',
            bind.span,
            `optional bind :${bind.name} must be inside when(${symbol.controller})`,
          );
        }
        const names =
          controlledUses.get(symbol.controller) ?? new Set<string>();
        names.add(bind.name);
        controlledUses.set(symbol.controller, names);
      }
    };

    const walk = (
      nodes: readonly SyqlLogicalTemplateNode[],
      active: ReadonlySet<string>,
    ): void => {
      for (const node of nodes) {
        if (node.kind === 'sql') {
          for (const part of node.parts) {
            if (part.kind === 'bind') record(part, active);
          }
        } else if (node.kind === 'predicate') {
          walk(node.body, active);
        } else if (node.kind === 'when') {
          const next = new Set(active);
          for (const control of node.controls) {
            usedControls.add(control);
            next.add(control);
          }
          walk(node.body, next);
        } else {
          for (const binding of node.directive.bindings) {
            for (const value of binding.values) {
              record(
                {
                  kind: 'bind',
                  name: value.name,
                  span: value.span,
                  origins: [value.span],
                },
                active,
              );
            }
          }
        }
      }
    };
    walk(template, new Set());

    for (const condition of conditions) {
      const conditionUses = new Set<string>();
      const collect = (nodes: readonly SyqlLogicalTemplateNode[]): void => {
        for (const node of nodes) {
          if (node.kind === 'sql') {
            for (const part of node.parts) {
              if (part.kind === 'bind') conditionUses.add(part.name);
            }
          } else if (node.kind === 'predicate') collect(node.body);
        }
      };
      collect(condition.body);
      condition.controls.forEach((control, index) => {
        const parameter = query.parameters.find(
          (item) => item.name === control,
        );
        if (parameter?.kind === 'value' && !conditionUses.has(control)) {
          this.#fail(
            'SYQL5010_UNUSED_CONTROL',
            condition.controlSpans[index] as SyqlSourceSpan,
            `when(${control}) does not use :${control} in its body`,
          );
        }
        if (
          parameter?.kind === 'group' &&
          !parameter.members.some((member) => conditionUses.has(member.name))
        ) {
          this.#fail(
            'SYQL5010_UNUSED_CONTROL',
            condition.controlSpans[index] as SyqlSourceSpan,
            `when(${control}) does not use a member of group ${control}`,
          );
        }
      });
    }

    for (const parameter of query.parameters) {
      if (parameter.kind === 'switch') {
        if (!usedControls.has(parameter.name)) {
          this.#unusedInput(parameter.nameSpan, parameter.name);
        }
      } else if (parameter.kind === 'group') {
        if (!usedControls.has(parameter.name)) {
          this.#unusedInput(parameter.nameSpan, parameter.name);
        }
        const uses = controlledUses.get(parameter.name) ?? new Set<string>();
        for (const member of parameter.members) {
          if (!uses.has(member.name))
            this.#unusedInput(member.nameSpan, member.name);
        }
      } else if (parameter.optional) {
        if (!usedControls.has(parameter.name) || !allUses.has(parameter.name)) {
          this.#unusedInput(parameter.nameSpan, parameter.name);
        }
      } else if (!allUses.has(parameter.name)) {
        this.#unusedInput(parameter.nameSpan, parameter.name);
      }
    }
  }

  #resolveTypeRequirements(
    symbols: ReadonlyMap<string, QueryBindSymbol>,
    requirements: ReadonlyMap<string, readonly SyqlValueType[]>,
  ): ReadonlyMap<string, SyqlValueType> {
    const resolved = new Map<string, SyqlValueType>();
    for (const symbol of symbols.values()) {
      if (symbol.type !== undefined) resolved.set(symbol.name, symbol.type);
    }
    for (const [name, constraints] of requirements) {
      const symbol = symbols.get(name);
      if (symbol === undefined) continue;
      const first = constraints[0];
      if (first === undefined) continue;
      for (const constraint of constraints.slice(1)) {
        if (constraint.base !== first.base) {
          this.#fail(
            'SYQL5011_TYPE_CONFLICT',
            symbol.span,
            `bind :${name} is constrained as both ${typeText(first)} and ${typeText(constraint)}`,
          );
        }
      }
      const inferred: SyqlValueType = {
        base: first.base,
        nullable: constraints.every((constraint) => constraint.nullable),
        span: first.span,
      };
      if (symbol.type !== undefined) {
        for (const formal of constraints) {
          if (!isCompatible(symbol.type, formal)) {
            this.#fail(
              'SYQL5011_TYPE_CONFLICT',
              symbol.span,
              `bind :${name} has type ${typeText(symbol.type)}, incompatible with predicate formal ${typeText(formal)}`,
            );
          }
        }
        resolved.set(name, symbol.type);
      } else {
        resolved.set(name, inferred);
      }
    }
    return resolved;
  }

  #parameterType(
    parameter: SyqlQueryParameter,
    resolved: ReadonlyMap<string, SyqlValueType>,
  ): SyqlValueType | undefined {
    if (parameter.kind === 'switch') return undefined;
    if (parameter.kind === 'group') {
      // Group members carry their own types; the logical input itself has no
      // scalar type. L3 consumes the per-member resolved map directly.
      return undefined;
    }
    return parameter.type ?? resolved.get(parameter.name);
  }

  #resolveCall(
    module: SyqlSyntaxFile,
    name: string,
    span: SyqlSourceSpan,
  ): SyqlResolvedPredicate {
    const target = this.#scopes.get(module.file)?.get(name);
    if (target === undefined) {
      this.#fail(
        'SYQL5001_UNKNOWN_PREDICATE',
        span,
        `unknown predicate @${name} in ${module.file}`,
      );
    }
    return target;
  }

  #checkArity(
    actual: number,
    target: SyqlResolvedPredicate,
    span: SyqlSourceSpan,
  ): void {
    const expected = target.declaration.parameters.length;
    if (actual !== expected) {
      this.#fail(
        'SYQL5003_PREDICATE_ARITY',
        span,
        `@${target.declaration.name} expects ${expected} argument(s), got ${actual}`,
      );
    }
  }

  #unusedInput(span: SyqlSourceSpan, name: string): never {
    this.#fail(
      'SYQL5007_UNUSED_INPUT',
      span,
      `query input ${name} is declared but not meaningfully used`,
    );
  }

  #fail(
    code: SyqlSemanticErrorCode,
    span: SyqlSourceSpan,
    message: string,
  ): never {
    throw new SyqlFrontendError(code, span, message);
  }
}

/** Resolve and statically validate a complete reachable SYQL module graph. */
export function analyzeSyqlSemantics(
  graph: SyqlModuleGraph,
): SyqlSemanticProgram {
  return new SemanticAnalyzer(graph).analyze();
}

/** Losslessly render expanded SQL/predicate nodes, retaining `when` markers. */
export function renderSyqlLogicalTemplate(
  nodes: readonly SyqlLogicalTemplateNode[],
): string {
  return nodes
    .map((node) => {
      if (node.kind === 'sql') {
        return node.parts
          .map((part) => (part.kind === 'text' ? part.text : `:${part.name}`))
          .join('');
      }
      if (node.kind === 'predicate') {
        return `(${renderSyqlLogicalTemplate(node.body)})`;
      }
      if (node.kind === 'when') {
        return `when(${node.controls.join(', ')}) {${renderSyqlLogicalTemplate(node.body)}}`;
      }
      return node.directive.tokens.map((token) => token.text).join('');
    })
    .join('');
}
