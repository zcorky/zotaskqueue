
import { nextTick as noDelayNextTick } from '@zodash/next-tick';
import { delay } from '@zodash/delay';
import { Queue } from '@zodash/queue';
import { strategy as createStrategy } from '@zodash/strategy';

import { STATUS } from './types';
import { Pool } from './pool';
import { IWorker, Worker } from './worker';

export type MasterCallback = (error: Error | null | undefined, worker: IWorker | undefined, workers: Pool) => void;

export type StatusSet = Record<STATUS, Set<string>>
export type StatusQueue = Record<STATUS.PENDING | STATUS.RUNNING, Queue<string>>;

const nextTick = async (fn: Function) => {
  await delay(300);
  fn.call(null);
}

export interface IMaster {
  /**
   * is up
   */
  isUp: boolean;

  /**
   * Start Up
   */
  startup(): Promise<void>;

  /**
   * Shut Down
   */
  shutdown(): Promise<void>;

  /**
   * Create Worker Into Pool
   * 
   * @param W Worker Class
   * @param options Worker Options
   */
  create<P>(W: Worker<P>, options: P): Promise<IWorker<P>>;

  /**
   * Get Worker From Pool
   * 
   * @param id worker id
   */
  get<P>(id: string): Promise<IWorker<P>>;

  /**
   * Remove Worker From Pool
   * 
   * @param id worker id
   */
  remove(id: string): Promise<void>;

  /**
   * Execute Worker
   * 
   * @param id worker id
   */
  execute(id: string): Promise<void>;

  /**
   * Cancel Worker
   * @param id worker id
   */
  cancel(id: string): Promise<void>;

  /**
   * Pause Worker
   * 
   * @param id worker id
   */
  pause(id: string): Promise<void>;

  /**
   * Resume Worker
   * 
   * @param id worker id
   */
  resume(id: string): Promise<void>;
  
  /**
   * Execute All Workers (Start All)
   */
  executeAll(): Promise<void>;

  /**
   * Cancel All Workers (Cancel All)
   */
  cancelAll(): Promise<void>;

  /**
   * Pause All Workers (Pause All)
   */
  pauseAll(): Promise<void>;

  /**
   * Export Workers
   */
  export(): Promise<void>;

  /**
   * Import Workers
   */
  import(): Promise<void>;

  /**
   * Set Concurrency
   * 
   * @param concurrency concurrency count
   */
  setConcurrency(concurrency: number): Promise<void>;

  /**
   * Set Timeout for Each Worker
   * 
   * @param timeout timeout, ms
   */
  setTimeout(timeout: number): Promise<void>;

  /**
   * Set Priority for Specific Worker
   * 
   * @param id worker id
   * @param priority priority weight
   */
  setPriority(id: string, priority: number): Promise<void>;
}

export interface MasterOptions {
  concurrency?: number;
  timeout?: number;
}

export class Master implements IMaster {
  private readonly listeners: Record<string, MasterCallback[]> = {};
  
  private readonly concurrency = this.options.concurrency || 2;

  private _isUp = false;

  private readonly workers = new Pool({ capacity: Infinity });

  private running = 0;
  private readonly statusSets: StatusSet = {
    [STATUS.INITIALED]: new Set(),
    [STATUS.PENDING]: new Set(), // @TODO
    [STATUS.RUNNING]: new Set(), // @TODO
    [STATUS.COMPLETE]: new Set(),
    [STATUS.ERROR]: new Set(),
    [STATUS.TIMEOUT]: new Set(),
    [STATUS.CANCELLED]: new Set(),
    [STATUS.PAUSED]: new Set(),
  };
  public readonly queue: StatusQueue = {
    [STATUS.PENDING]: new Queue<string>(Infinity),
    [STATUS.RUNNING]: new Queue<string>(this.concurrency),
  };

  constructor(public readonly options: MasterOptions = {}) {}

  public get isUp() {
    return this._isUp;
  }

  // event
  public emit(event: string | string[], error?: Error | null, worker?: IWorker) {
    const events = Array.isArray(event) ? event : [event];

    for (const event of events) {
      if (!this.listeners[event]) continue;

      this.listeners[event].forEach(cb => {
        cb(error, worker, this.workers);
      });
    }

    return this;
  }

  public on(event: string, cb: MasterCallback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }

    this.listeners[event].push(cb);
    return this;
  }

  public off(event: string, cb: MasterCallback) {
    if (!this.listeners[event]) {
      return ;
    }

    const index = this.listeners[event].indexOf(cb);
    this.listeners[event].splice(index, 1);
    return this;
  }

  private updateStatus(worker: IWorker) {
    // remove
    if (worker.prevStatus === null) {
      //
    } else if ([STATUS.PENDING, STATUS.RUNNING].includes(worker.prevStatus)) {
      this.queue[worker.prevStatus as STATUS.PENDING | STATUS.RUNNING].dequeue();
    } else {
      this.statusSets[worker.prevStatus].delete(worker.id);
    }

    // add
    if ([STATUS.PENDING, STATUS.RUNNING].includes(worker.status)) {
      this.queue[worker.status as STATUS.PENDING | STATUS.RUNNING].enqueue(worker.id);
    } else {
      this.statusSets[worker.status].add(worker.id);
    }

    // const t = [STATUS.PENDING, STATUS.RUNNING];
    // if (t.includes(worker.prevStatus!) || t.includes(worker.status)) {
    //   console.log('update status: ', worker.filename, ' ', worker.prevStatus, ' => ', worker.status);
    //   console.log('queue size: ', 'pending-', this.queue.PENDING.size(), ' running-', this.queue.RUNNING.size());
    // }

    // create strategy
    const strategy = createStrategy<{ worker: IWorker, master: Master }, any>({
      [STATUS.INITIALED]: ({ master }) => {},
      [STATUS.PENDING]: ({ master }) => {},
      [STATUS.RUNNING]: ({ master }) => { master.running += 1; },
      [STATUS.COMPLETE]: ({ master }) => { master.running -= 1; },
      [STATUS.ERROR]: ({ master }) => { master.running -= 1; },
      [STATUS.TIMEOUT]: ({ master }) => { master.running -= 1; },
      [STATUS.CANCELLED]: ({ worker, master }) => {
        // worker did not start
        if (worker.prevStatus === STATUS.PENDING) return ;
        if (worker.prevStatus === STATUS.INITIALED) return ; // ensure, most will not trigger

        master.running -= 1;
      },
      [STATUS.PAUSED]: ({ master }) => { master.running -= 1; },
    }, ({ worker }) => {
      return worker.status;
    });
    
    // run
    strategy({ worker, master: this });
  }

  // concurrency
  private async parallel(limit: number) {
    for (let i = 0; i < limit; ++i) {
      nextTick(this.poll);
    }
  }

  private async next() {
     // dequeue
    try {
      const id = this.queue[STATUS.PENDING].peek(); // this.collection[STATUS.PENDING][0];
      // if (!id) return ;

      // worker
      return this.get(id);
    } catch (error) {
      return ;
    }
  }

  private poll = async () => {
    const rest = this.concurrency - this.running;

    // if shutdown, stop nextTick
    if (!this._isUp) {
      return ;
    } else if (rest === 0) {
      // watch when = 0, queue full
      return nextTick(this.poll);
    } else if (rest < 0) {
      // @TODO
      // throw new Error('Unexpected Error rest < 0');
      //
      // @TODO only when concurrency change, if rest < 0, should stop current
      return ;
    } else {
      // > 0
      const worker = await this.next();
      if (worker) {
        await worker.run();
        const self = this;

        // when finish call next / poll
        worker.on('finish', function done() {
          worker.off('finish', done);

          nextTick(self.poll);
        });
      } else {
        // watch when > 0, no worker found
        return nextTick(this.poll);
      }
    }

    // return nextTick(this.poll);
  }

  // functions
  public async startup() {
    this._isUp = true;

    await this.parallel(this.concurrency);
  }

  public async shutdown() {
    this._isUp = false;
  }
  
  public async create<P>(W: Worker<P>, options: P) {
    const worker = await this.workers.create(W, options);

    worker
      .on('progress', () => this.emit(['update', 'progress'], null, worker))
      .on('complete', () => {
        this.emit('complete', null, worker);
      })
      .on('error', (error) => {
        this.emit('error', error, worker);
      })
      .on('timeout', () => {
        this.emit('timeout', null, worker);
      })
      .on('cancel', () => {
        this.emit('cancel', null, worker);
      })
      .on('pause', () => {
        this.emit('pause', null, worker);
      })
      .on('run', () => {
        this.emit('run', null, worker);
      })
      .on('resume', () => {
        this.emit(['update', 'resume'], null, worker);
      })
      .on('update', (error) => {
        this.emit('update', error, worker);
      })
      .on('update:status', (error, worker) => {
        // concurrency
        this.updateStatus(worker);
      });
      // .on('finish', () => {
      //   // concurrency
      //   this.running -= 1;
      // });

    this.emit(['update', 'add']);

    return worker;
  }

  public async get<P>(id: string) {
    return this.workers.get<P>(id);
  }

  public async remove(id: string) {
    const worker = await this.get(id);

    if (!worker) {
      throw new Error(`Invalid Worker ID(${id})`);
    }

    if ([STATUS.PENDING, STATUS.RUNNING].includes(worker.status)) {
      throw new Error(`Cannot remove the worker, which is PENDING or RUNNING.`);
    }

    if (!this.statusSets[worker.status].has(worker.id)) {
      throw new Error(`Worker(${worker.id}) was not in Set(${worker.status})`);
    }

    // remove from set
    this.statusSets[worker.status].delete(worker.id);

    // remove from workers pool
    this.workers.remove(id);

    this.emit('update');
  }

  public async execute(id: string) {
    if (!this._isUp) {
      throw new Error(`Your machine is not start up, please startup first.`);
    }

    const worker = await this.get(id);

    worker.pending();
  }

  public async cancel(id: string) {
    const worker = await this.get(id);

    await worker.cancel();
  }

  public async pause(id: string) {
    const worker = await this.get(id);

    await worker.pause();
  }

  public async resume(id: string) {
    const worker = await this.get(id);
    
    await worker.resume();
  }

  /**
   * Start All Workers
   */
  public async executeAll() {
    await Promise.all(this.workers.map(worker => this.execute(worker.id)));
  }

  /**
   * Cancel All Workers
   */
  public async cancelAll() {
    await Promise.all(this.workers.map(worker => this.cancel(worker.id)));
  }

  /**
   * Pause All Workers
   */
  public async pauseAll() {
    await Promise.all(this.workers.map(worker => this.pause(worker.id)));
  }

  public async export() {
    throw new Error('@WIP 拼命开发中...');
  }

  public async import() {
    throw new Error('@WIP 拼命开发中...');
  }

  public async setConcurrency(concurrency: number) {
    if (concurrency < 0) {
      throw new Error('Concurrency cannot be less than 0');
    }

    const more = concurrency - this.concurrency;
    (this as any).concurrency = concurrency;

    // if more > 0, should run more parallel process
    if (more > 0) {
      await this.parallel(more);
    }
  }

  public async setTimeout() {
    throw new Error('@WIP 拼命开发中...');
  }

  public async setPriority(id: string, priority: number) {
    throw new Error('@WIP 拼命开发中...');
  }
}