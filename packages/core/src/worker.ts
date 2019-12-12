import { uuid } from '@zodash/uuid';

import { STATUS } from './types';

let uniqueId = 0;

export type WorkerCallback<P> = (error: Error | null, worker: Worker<P>) => void;

export interface IWorker<P = any> {
  new?(options: P): P;
  readonly options: P;

  readonly id: string;
  readonly status: STATUS;
  readonly prevStatus: STATUS;
  readonly progress: number;
  readonly speed: number;

  pending(): Promise<void>;
  run(): Promise<void>;
  cancel(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;

  on(event: string, cb: WorkerCallback<P>): void;
  emit(event: string | string[], error?: Error): void;
  off(event: string, cb: WorkerCallback<P>): void;
}

export interface WorkerOptions {
  label?: string;
  version?: string;
  retries?: number;
  retryAfterMs?: number;
  retryOnError?: boolean;
  retryOnTimeout?: boolean;
}

export abstract class Worker<P extends WorkerOptions> implements IWorker<P> {
  private readonly listeners: Record<string, WorkerCallback<P>[]> = {};

  // worker
  public readonly id = 'worker-' + uniqueId++; // uuid();
  public readonly prevStatus: STATUS | null = null;
  public readonly status: STATUS = STATUS.INITIALED;
  public readonly progress = 0;
  public readonly label = this.options.label;
  public readonly version = this.options.version;
  // public readonly speed: number = 0;
  // mtime
  public readonly createdAt = new Date();
  public readonly updatedAt = new Date();
  // options
  public retries = this.options.retries || 0;
  public readonly retryAfterMs = this.options.retryAfterMs || 0;
  public readonly retryOnError = this.options.retryOnError || true;
  public readonly retryOnTimeout = this.options.retryOnTimeout || true;

  constructor(public readonly options: P) {
    this.on('run', () => {
      this.setStatus(STATUS.RUNNING);

      this.emit('update')
    })
      .on('complete', () => {
        this.setStatus(STATUS.COMPLETE);
        
        // finish
        this.emit(['update', 'finish']);
      })
      .on('error', () => {
        this.setStatus(STATUS.ERROR);
        // this.setProgress(0);

        // finish
        this.emit(['update', 'finish']);

        // retry
        if (this.retryOnError) {
          this.emit('retry');
        }
      })
      .on('timeout', () => {
        this.setStatus(STATUS.TIMEOUT);
        // this.setProgress(0);

        // finish
        this.emit(['update', 'finish']);

        // retry
        if (this.retryOnTimeout) {
          this.emit('retry');
        }
      })
      .on('cancel', () => {
        this.setStatus(STATUS.CANCELLED);
        this.setProgress(0);

        // finish
        this.emit(['update', 'finish']);
      })
      .on('pause', () => {
        this.setStatus(STATUS.PAUSED);

        // // finish
        // this.emit('finish');
      })
      .on('resume', () => {
        this.setStatus(STATUS.RUNNING);
      })
      .on('retry', () => {
        // should not retry
        if (!this.retries || this.retries <= 0) return ;
        
        this.retries -= 1;
        setTimeout(() => {
          this.pending();
        }, this.retryAfterMs);
      });
  }

  public emit(event: string | string[], error?: Error) {
    const events = Array.isArray(event) ? event : [event];

    for (const event of events) {
      if (!this.listeners[event]) continue;
      
      this.listeners[event].forEach(cb => {
        cb(error || null, this);
      });
    }

    return this;
  }

  public on(event: string, cb: WorkerCallback<P>) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }

    this.listeners[event].push(cb);
    return this;
  }

  public off(event: string, cb: WorkerCallback<P>) {
    if (!this.listeners[event]) {
      return ;
    }

    const index = this.listeners[event].indexOf(cb);
    this.listeners[event].splice(index, 1);
    return this;
  }

  public get speed() {
    const distance = this.size * this.progress;
    const time = (+new Date() - (+this.createdAt)) / 1000;
    return distance / time;
  }

  public get estimatedTimeToArrival() {
    const restDistance = this.size * (1 - this.progress);
    return restDistance / this.speed;
  }

  protected setProgress(progress: number) {
    (this as any).progress = progress;
  }

  protected setStatus(status: STATUS) {
    (this as any).prevStatus = this.status;
    (this as any).status = status;

    // if not resume, should reset process and speed
    if (this.status === STATUS.PENDING && this.prevStatus !== STATUS.PAUSED) {
      if (this.progress !== 0) {
        this.setProgress(0);
      }
    }

    this.emit('update:status');
  }

  public toJSON() {
    return {
      id: this.id,
      status: this.status,
      preStatus: this.prevStatus,
      progress: this.progress,
      speed: this.speed, // === 0 ? '-' : humanFileSize(this.speed.toFixed(2), true) + '/s',
    };
  }

  // functions
  public async pending() {
    if (this.status === STATUS.PENDING) return ;
    if (this.status === STATUS.RUNNING) return ;

    this.setStatus(STATUS.PENDING);
    this.emit('update');
  }

  public async run() {
    return new Promise<void>((resolve, reject) => {
      if (this.status === STATUS.RUNNING) return ;

      const self = this;
      let it = setTimeout(() => {
        return reject(new Error('timeout to run'));
      }, 3000);

      return this
        .on('run', function done() {
          clearTimeout(it);
          (it as any) = null;
          
          self.off('run', done);
          return resolve();
        })
        .handle();
    });
  }

  public async cancel() {
    return new Promise<void>((resolve, reject) => {
      if (this.status !== STATUS.PENDING && this.status !== STATUS.RUNNING) {
        return ;
      }
      
      const self = this;
      let it = setTimeout(() => {
        return reject(new Error('timeout to cancel'));
      }, 3000);

      this.on('cancel', function done() {
          clearTimeout(it);
          (it as any) = null;
          (self as any).xhr = null;
          
          self.off('cancel', done);
          return resolve();
      });

      try {
        this.abort();
      } catch (error) {
        reject(error);
      }
    });
  }
  
  public async pause() {
    // if not status(pending + running), ignore
    if (![STATUS.PENDING, STATUS.RUNNING].includes(this.status)) {
      return ;
    }

    alert('拼命开发中');
  }
  
  public async resume() {
    // if not status(paused), ignore
    if (this.status !== STATUS.PAUSED) {
      return ;
    }

    alert('拼命开发中');
  }

  // need rewrite
  public abstract get size(): number;

  public abstract handle(): void;

  public abstract abort(): void;
}