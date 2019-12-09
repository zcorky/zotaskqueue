
import { nextTick as noDelayNextTick } from '@zodash/next-tick';
import { delay } from '@zodash/delay';
import { Queue } from '@zodash/queue';
import { strategy as createStrategy } from '@zodash/strategy';

import { Worker, STATUS } from './worker';

export type MasterCallback = (error: Error | null | undefined, worker: Worker | undefined, workers: Worker[]) => void;

export type StatusSet = Record<STATUS, Set<string>>
export type StatusQueue = Record<STATUS.PENDING | STATUS.RUNNING, Queue<string>>;

const nextTick = async (fn: Function) => {
  await delay(300);
  fn.call(null);
} 

export class Master {
  private readonly listeners: Record<string, MasterCallback[]> = {};
  
  private readonly workers: Worker[] = [];
  
  private readonly concurrency = 2;
  private running = 0;
  private readonly statusSet: StatusSet = {
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

  // event
  public emit(event: string | string[], error?: Error | null, worker?: Worker) {
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

  // task
  public get indexedWorkers() {
    return this.workers.reduce((all, worker) => {
      all[worker.id] = worker;
      return all;
    }, {} as Record<string, Worker>);
  }

  public async get(id: string) {
    return this.indexedWorkers[id] || null;
  }

  public async remove(id: string) {
    const worker = await this.get(id);

    if (!worker) {
      throw new Error(`Invalid Worker ID(${id})`);
    }

    const index = this.workers.indexOf(worker);
    this.workers.splice(index, 1);

    this.emit('update');
  }

  // base
  public async add(file: File | File[]) {
    const files = Array.isArray(file) ? file : [file];

    for (const file of files) {
      const worker = new Worker(file);
      
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
      
      this.workers.push(worker);
    }

    this.emit(['update', 'add']);
  }

  private updateStatus(worker: Worker) {
    // remove
    if (worker.prevStatus === null) {
      //
    } else if ([STATUS.PENDING, STATUS.RUNNING].includes(worker.prevStatus)) {
      this.queue[worker.prevStatus as STATUS.PENDING | STATUS.RUNNING].dequeue();
    } else {
      this.statusSet[worker.prevStatus].delete(worker.id);
    }

    // add
    if ([STATUS.PENDING, STATUS.RUNNING].includes(worker.status)) {
      this.queue[worker.status as STATUS.PENDING | STATUS.RUNNING].enqueue(worker.id);
    } else {
      this.statusSet[worker.status].add(worker.id);
    }

    // const t = [STATUS.PENDING, STATUS.RUNNING];
    // if (t.includes(worker.prevStatus!) || t.includes(worker.status)) {
    //   console.log('update status: ', worker.filename, ' ', worker.prevStatus, ' => ', worker.status);
    //   console.log('queue size: ', 'pending-', this.queue.PENDING.size(), ' running-', this.queue.RUNNING.size());
    // }

    // create strategy
    const strategy = createStrategy<{ worker: Worker, master: Master }, any>({
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

  // functions
  public start(worker: Worker): Promise<void>
  public start(id: string): Promise<void>
  public async start(idOrWorker: string | Worker) {
    // hand pending, not start, only change status
    const worker = typeof idOrWorker === 'string'
      ? await this.get(idOrWorker)
      : idOrWorker;

    worker.pending();

    return this.parallel();
  }

  public cancel(worker: Worker): Promise<void>
  public cancel(id: string): Promise<void>
  public async cancel(idOrWorker: string | Worker) {
    if (typeof idOrWorker === 'string') {
      return (await this.get(idOrWorker)).cancel();
    }

    return idOrWorker.cancel(); 
  }

  public pause = async (id: string) => {
    return (await this.get(id)).pause();
  }

  public resume = async (id: string) => {
    return (await this.get(id)).resume();
  }

  public startAll = async () => {
    return Promise.all(this.workers.map(worker => this.start(worker)));
  }

  public cancelAll = async () => {
    return Promise.all(this.workers.map(worker => this.cancel(worker)));
  }

  // concurrency
  private async parallel() {
    // already running
    if (this.running != 0) return ;

    for (let i = 0; i < this.concurrency; ++i) {
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

    if (rest === 0) {
      // watch when = 0, queue full
      return nextTick(this.poll);
    } else if (rest < 0) {
      throw new Error('Unexpected Error rest < 0');
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
}