import { uuid } from '@zodash/uuid';
import { md5, humanFileSize } from './utils';

let uniqueId = 0;

export type WorkerCallback = (error: Error | null, worker: Worker) => void;

export enum STATUS {
  INITIALED = 'INITIALED',
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETE = 'COMPLETE',
  ERROR = 'ERROR',
  TIMEOUT = 'TIMEOUT',
  CANCELLED = 'CANCELLED',
  PAUSED = 'PAUSED',
}

export class Worker {
  private readonly listeners: Record<string, WorkerCallback[]> = {};

  // worker
  public readonly id = 'worker-' + uniqueId++; // uuid();
  public readonly md5: string | null = null;
  public readonly prevStatus: STATUS | null = null;
  public readonly status: STATUS = STATUS.INITIALED;
  public readonly progress = 0;
  public readonly speed: number = 0;
  // delegate file
  public readonly filename = this.file.name;
  public readonly fileSize = this.file.size;
  public readonly lastModified = this.file.lastModified;
  // mtime
  public readonly createdAt = new Date();
  public readonly updatedAt = new Date();

  private readonly xhr?: XMLHttpRequest | null;

  constructor(public readonly file: File) {
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
      })
      .on('timeout', () => {
        this.setStatus(STATUS.TIMEOUT);
        // this.setProgress(0);

        // finish
        this.emit(['update', 'finish']);
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
      });

    md5(file).then(v => {
      (this as any).md5 = v;
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

  public on(event: string, cb: WorkerCallback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }

    this.listeners[event].push(cb);
    return this;
  }

  public off(event: string, cb: WorkerCallback) {
    if (!this.listeners[event]) {
      return ;
    }

    const index = this.listeners[event].indexOf(cb);
    this.listeners[event].splice(index, 1);
    return this;
  }

  private setProgress(progress: number) {
    (this as any).progress = progress;

    this.calcSpeed();
  }

  private calcSpeed() {
    const distance = this.fileSize * this.progress;
    const time = (+new Date() - (+this.createdAt)) / 1000; // @TODO
    // (this as any).speed = (distance / time).toFixed(2);
    this.setSpeed(distance / time);
  }

  private setSpeed(speed: number) {
    (this as any).speed = speed;
  }

  private setStatus(status: STATUS) {
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

  public get progressHuman() {
    return this.progress === 0 ? '-' : (this.progress * 100).toFixed(2) + '%';
  }

  public get speedHuman() {
    return this.speed === 0 ? '-' : humanFileSize(this.speed.toFixed(2), true) + '/s';
  }

  public toJSON() {
    return {
      id: this.id,
      filename: this.file.name,
      status: this.status,
      preStatus: this.prevStatus,
      progress: this.progress,
      speed: this.speed, // === 0 ? '-' : humanFileSize(this.speed.toFixed(2), true) + '/s',
      size: this.file.size,
      file: this.file,
    };
  }

  private request = (file: File) => {
    this.emit('run');

    const xhr = (this as any).xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (e) => {
      const progress = e.loaded / e.total;
      this.setProgress(progress);

      this.emit('progress');
    }, false);

    xhr.addEventListener('load', () => {
      this.emit('complete');
    }, false);

    xhr.addEventListener('error', (error) => {
      this.emit('error', new Error('Network Error'));
      // @TODO
      // 1.Server Close Error
      // 2.Client Network Error
    }, false);

    xhr.addEventListener('abort', () => {
      this.emit('cancel');
    }, false);

    xhr.addEventListener('timeout', () => {
      this.emit('timeout');
    }, false);

    // xhr.responseType = 'json';

    const form = new FormData();
    form.append('file', file);

    xhr.open('POST', 'https://httpbin.zcorky.com/upload');

    xhr.send(form);
  }

  public upload() {
    this.request(this.file);

    return this;
  }

  // functions
  public async pending() {
    if (this.status === STATUS.PENDING) return ;
    if (this.status === STATUS.RUNNING) return ;

    this.setStatus(STATUS.PENDING);
    this.emit('update');
  }

  public async run() {
    return new Promise((resolve, reject) => {
      if (this.status === STATUS.RUNNING) return ;

      const self = this;
      let it = setTimeout(() => {
        if (this.xhr) {
          this.xhr.abort();
        }

        reject(new Error('timeout to run'));
      }, 3000);

      this
        .on('run', function done() {
          clearTimeout(it);
          (it as any) = null;
          
          self.off('run', done);
          resolve();
        })
        .upload();
    });
  }

  public async cancel() {
    return new Promise((resolve, reject) => {
      if (this.status !== STATUS.PENDING && this.status !== STATUS.RUNNING) {
        return ;
      }
      
      const self = this;
      let it = setTimeout(() => {
        if (this.xhr) {
          this.xhr.abort();
        }

        reject(new Error('timeout to cancel'));
      }, 3000);

      this.on('cancel', function done() {
          clearTimeout(it);
          (it as any) = null;
          (self as any).xhr = null;
          
          self.off('cancel', done);
          resolve();
      });

      try {
        // already run
        if (this.xhr) {
          this.xhr.abort();
        } else {
          // still pending
          this.emit('cancel');
        }
      } catch (error) {
        reject(error);
      }
    });
  }
  
  public async pause() {
    alert('拼命开发中');
  }
  
  public async resume() {
    alert('拼命开发中');
  }
}