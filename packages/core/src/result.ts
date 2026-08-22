/**
 * @file Defines Archer's immutable Result monad and its pure combinators.
 *
 * A failure always carries a real Error instance. Domain-specific error classes
 * may narrow that type, while callers that do not care about the category retain
 * the ordinary `Error` default.
 */

/** The success branch reused by predicates so its members have one definition. */
type OkResult<Value> = Readonly<{
  /** Identifies the success branch for TypeScript and runtime consumers. */
  ok: true;

  /** Carries the successful value without cloning or coercing it. */
  value: Value;
}>;

/** The failure branch reused by predicates so its members have one definition. */
type ErrorResult<Failure extends Error> = Readonly<{
  /** Identifies the failure branch for TypeScript and runtime consumers. */
  ok: false;

  /** Retains the exact Error instance, including its stack and cause. */
  error: Failure;
}>;

/** A synchronous success or failure value with one exact discriminant. */
export type Result<Value, Failure extends Error = Error> = OkResult<Value> | ErrorResult<Failure>;

/** Extracts one success payload from a Result tuple member. */
type ResultValueOf<Item> = Extract<Item, OkResult<unknown>> extends OkResult<infer Value> ? Value : never;

/** Extracts one Error subtype from a Result tuple member. */
type ResultErrorOf<Item> = Extract<Item, ErrorResult<Error>> extends ErrorResult<infer Failure> ? Failure : never;

/** Preserves each success payload at its exact tuple position. */
type ResultValues<Results extends readonly Result<unknown, Error>[]> = Readonly<{
  [Index in keyof Results]: ResultValueOf<Results[Index]>;
}>;

/** Exhaustive callbacks used to collapse both Result branches into one output union. */
export type ResultMatch<Value, Failure extends Error, OkOutput, ErrorOutput = OkOutput> = Readonly<{
  /** Handles the success payload without constraining the failure output. */
  ok(value: Value): OkOutput;

  /** Handles the exact failure instance without constraining the success output. */
  error(error: Failure): ErrorOutput;
}>;

/**
 * Pure Result constructors and transformations.
 *
 * The operations never mutate a Result or its payload. Failure branches preserve
 * object identity unless a caller explicitly supplies `mapError`.
 */
export const Result = Object.freeze({
  /**
   * Wraps a value in a frozen success envelope without cloning the value.
   * @param value - The successful value owned by the caller.
   * @returns An immutable success discriminant.
   */
  ok<Value>(value: Value): Result<Value, never> {
    return Object.freeze({ ok: true, value });
  },

  /**
   * Wraps the exact Error instance in a frozen failure envelope.
   * @param error - The failure whose identity, stack, and cause must survive.
   * @returns An immutable failure discriminant.
   */
  error<Failure extends Error>(error: Failure): Result<never, Failure> {
    return Object.freeze({ ok: false, error });
  },

  /**
   * Narrows a Result to its success branch without inspecting the payload.
   * @param result - The Result to discriminate.
   * @returns Whether the Result contains a value.
   */
  isOk<Value, Failure extends Error>(result: Result<Value, Failure>): result is OkResult<Value> {
    return result.ok;
  },

  /**
   * Narrows a Result to its failure branch without changing the Error.
   * @param result - The Result to discriminate.
   * @returns Whether the Result contains an Error.
   */
  isError<Value, Failure extends Error>(result: Result<Value, Failure>): result is ErrorResult<Failure> {
    return !result.ok;
  },

  /**
   * Transforms only a success payload and returns an existing failure unchanged.
   * @param result - The source Result.
   * @param transform - A pure value transformation invoked only for success.
   * @returns The transformed success or original failure.
   */
  map<Value, Next, Failure extends Error>(
    result: Result<Value, Failure>,
    transform: (value: Value) => Next,
  ): Result<Next, Failure> {
    return result.ok ? Result.ok(transform(result.value)) : result;
  },

  /**
   * Sequences a Result-producing transformation and short-circuits on failure.
   * @param result - The source Result.
   * @param transform - The next computation, invoked only for success.
   * @returns The next Result or the original failure.
   */
  flatMap<Value, Next, Failure extends Error, NextFailure extends Error>(
    result: Result<Value, Failure>,
    transform: (value: Value) => Result<Next, NextFailure>,
  ): Result<Next, Failure | NextFailure> {
    return result.ok ? transform(result.value) : result;
  },

  /**
   * Reclassifies only a failure while preserving an existing success by identity.
   * @param result - The source Result.
   * @param transform - An Error transformation invoked only for failure.
   * @returns The original success or transformed failure.
   */
  mapError<Value, Failure extends Error, NextFailure extends Error>(
    result: Result<Value, Failure>,
    transform: (error: Failure) => NextFailure,
  ): Result<Value, NextFailure> {
    return result.ok ? result : Result.error(transform(result.error));
  },

  /**
   * Evaluates exactly one branch and collapses the Result into a caller-owned type.
   * @param result - The Result to exhaustively handle.
   * @param branches - Callbacks for both discriminated branches.
   * @returns The value produced by the selected branch.
   */
  match<Value, Failure extends Error, OkOutput, ErrorOutput>(
    result: Result<Value, Failure>,
    branches: ResultMatch<Value, Failure, OkOutput, ErrorOutput>,
  ): OkOutput | ErrorOutput {
    return result.ok ? branches.ok(result.value) : branches.error(result.error);
  },

  /**
   * Collects successes in input order and stops at the first failure.
   *
   * The successful array is frozen. This operation is linear in the number of
   * Results inspected and does not invoke or evaluate deferred work.
   * @param results - Already evaluated Results in caller-defined order.
   * @returns All values in order, or the first Error by identity.
   */
  all<const Results extends readonly Result<unknown, Error>[]>(
    results: Results,
  ): Result<ResultValues<Results>, ResultErrorOf<Results[number]>> {
    /** Accumulates only values preceding any failure and never escapes mutable. */
    const values: unknown[] = [];

    /** Each binding retains the caller's exact sequence and first-error policy. */
    for (const result of results) {
      if (!result.ok) return result as Result<never, ResultErrorOf<Results[number]>>;
      values.push(result.value);
    }

    return Result.ok(Object.freeze(values) as ResultValues<Results>);
  },
} as const);
