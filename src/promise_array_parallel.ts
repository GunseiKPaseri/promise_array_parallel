import { generatePromiseResolveList, sleep } from "./util.ts";

/**
 * index & value
 */
type IdxValue<T> = { idx: number; value: T; rejected: false };
type RejectableIdxValue<T> = IdxValue<T> | {
  idx: number;
  // deno-lint-ignore no-explicit-any
  reason: any;
  rejected: true;
};
type PromiseIdxValueArray<T extends readonly unknown[]> = {
  [P in keyof T]: Promise<RejectableIdxValue<T[P]>>;
};

export type ParallelWorkOptions = {
  parallelDegMax: number;
  priority: "COME" | "INDEX";
  workIntervalMS: number;
};

/**
 * promise array object
 */
export class PromiseArray<T extends readonly unknown[]> {
  /**
   * make resolved Promise object
   * @param `array` using array
   * @returns `PromiseArray`
   */
  static from<T extends readonly unknown[]>(array: T): PromiseArray<T> {
    return new PromiseArray<T>(
      array.map((value, idx) => Promise.resolve({ idx, value, rejected: false }) // deno-lint-ignore no-explicit-any
      ) as any,
    );
  }

  /**
   * @param `array` promise array
   */
  constructor(array: PromiseIdxValueArray<T>) {
    this.#array = array;
  }

  #array: PromiseIdxValueArray<T>;

  /**
   * `Promise[]` raw object
   */
  get raw() {
    return Object.freeze(this.#array);
  }

  /**
   * solve like `Promise.all`
   * @returns solved array
   */
  all() {
    return Promise.all(this.#array)
      .then((x) =>
        new Promise((resolve, reject) => {
          const t = x.map((y) => {
            if (y.rejected) {
              reject(y.reason);
              return;
            }
            return y.value;
          });
          resolve(t);
        })
      );
  }

  /**
   * solve like `Promise.allSettled`
   * @returns solved array
   */
  allSettled(): Promise<PromiseSettledResult<T[number]>[]> {
    return Promise.allSettled(this.#array).then((x) => (
      x.map((y) =>
        y.status === "fulfilled" && !y.value.rejected
          ? {
            status: "fulfilled" as const,
            value: y.value.value,
          }
          : {
            status: "rejected" as const,
            reason: (y.status === "fulfilled" ? y.value.rejected : y.reason),
          }
      )
    ));
  }

  /**
   * Execute works in parallel
   * @param `work` async func
   * @param `options`
   * @returns `PromiseArray`
   */
  parallelWork<U>(
    work: <V extends T[number]>(idxval: IdxValue<V>) => Promise<U>,
    options?: Partial<ParallelWorkOptions>,
  ) {
    // initialize
    const { parallelDegMax = Infinity, priority = "COME", workIntervalMS = 0 } =
      options ?? {};

    const chunkSize = Math.max(Math.min(parallelDegMax, this.#array.length), 1);

    const iter = priority === "COME" ? this.fcfs() : this.fifs();

    // ??????????????????????????????
    const waitingTaskQueue: RejectableIdxValue<T[number]>[] = [];
    // ?????????????????????????????????????????????????????????
    let workspace: symbol[] = [];

    // ???????????????????????????
    const releaceWorkspaceUnique = (uniqueKey: symbol) => {
      workspace = workspace.filter((key) => key !== uniqueKey);
      //???????????????????????????
      tryNextTask();
    };

    const { resolveList, promiseList } = generatePromiseResolveList<
      RejectableIdxValue<U>
    >(this.#array.length);

    // ?????????????????????work?????????
    const tryNextTask = () => {
      if (workspace.length >= chunkSize) return;
      const nextTask = waitingTaskQueue.shift();
      if (!nextTask) return;
      // ????????????????????????????????????
      const workspaceKey = Symbol();
      workspace.push(workspaceKey);
      const wrappedWork = async (): Promise<RejectableIdxValue<U>> => {
        if (nextTask.rejected) return nextTask;
        try {
          return {
            idx: nextTask.idx,
            value: await work(nextTask),
            rejected: false,
          };
        } catch (e) {
          return { idx: nextTask.idx, reason: e, rejected: true };
        }
      };
      wrappedWork().then((result) => {
        // ????????????????????????????????????????????????????????????
        releaceWorkspaceUnique(workspaceKey);
        // ???????????????
        resolveList[nextTask.idx](result);
      });
    };

    // ??????????????????????????????
    (async () => {
      for await (const nextTarget of iter) {
        waitingTaskQueue.push(nextTarget);
        tryNextTask();
        await sleep(workIntervalMS);
      }
    })();

    return new PromiseArray(promiseList);
  }

  /**
   * First-Come-First-Served
   */
  async *fcfs() {
    const { resolveList, promiseList: fcfslize } = generatePromiseResolveList<
      RejectableIdxValue<T[number]>
    >(this.#array.length);

    // fcfs resolve
    let i = 0;
    this.#array.map((x) =>
      x.then((v) => {
        resolveList[i++](v);
      })
    );
    for await (const x of fcfslize) {
      yield x;
    }
  }

  /**
   * First-Index-First-Served
   */
  async *fifs() {
    const { resolveList, promiseList: fifslize } = generatePromiseResolveList<
      RejectableIdxValue<T[number]>
    >(this.#array.length);

    // fifs resolve
    this.#array.map((x) =>
      x.then((v) => {
        resolveList[v.idx](v);
      })
    );
    for await (const x of fifslize) {
      yield x;
    }
  }
}
