import { Worker } from '@zoupdown/core';

import { md5, humanFileSize } from './utils';

export interface Options {
  url: string;
  method?: string;
  headers?: Headers;
  data?: Record<string, string>;
  withCredentials?: boolean;
  timeout?: number;
  file: File;
}

const DEFAULT_METHOD = 'POST';

export class UploadWorker extends Worker<Options> {
  // delegate file
  public readonly filename = this.options.file.name;
  public readonly fileSize = this.options.file.size;
  public readonly lastModified = this.options.file.lastModified;
  public readonly md5: string | null = null;
  public readonly response: Response | null = null;

  private readonly xhr: XMLHttpRequest | null;

  constructor(options: Options) {
    super(options);

    md5(options.file).then(v => {
      (this as any).md5 = v;
    });
  }


  public toJSON() {
    return {
      id: this.id,
      status: this.status,
      preStatus: this.prevStatus,
      progress: this.progress,
      speed: this.speed, // === 0 ? '-' : humanFileSize(this.speed.toFixed(2), true) + '/s',
      size: this.fileSize,
      file: this.options.file,
      filename: this.filename,
      md5: this.md5,
    };
  }

  public size() {
    return this.fileSize;
  }

  public handle() {
    this.emit('run');

    const xhr = (this as any).xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (e) => {
      const progress = e.loaded / e.total;
      this.setProgress(progress);

      this.emit('progress');
    }, false);

    xhr.addEventListener('load', () => {
      if (xhr.readyState === 4) {

        const headers = {};
        xhr.getAllResponseHeaders().replace(/^(.*?):[^\S\n]*([\s\S]*?)$/gm, (m, key, value) => {
          headers[key] = headers[key] ? `${headers[key]},${value}` : value;
          return '';
        });

        (this as any).response = new Response(xhr.responseText, {
          status: xhr.status,
          statusText: xhr.statusText,
          headers: new Headers(headers),
        });

        if (xhr.status >= 200 && xhr.status < 400) {
          // health
          this.emit('complete');
        } else {
          // unhealth 400+ 500+
          const error = new Error(`[${xhr.status}] ${xhr.statusText}`) as any;
          error.status = xhr.status;
          error.response = this.response;
          this.emit('error', error);
        }
      }
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

    const headers = this.options.headers || {};
    for (const key in headers) {
			xhr.setRequestHeader(key, headers[key]);
		}

    const form = new FormData();
    form.append('file', this.options.file);
    const data = this.options.data || {};
    for (const key in data) {
      form.append(key, data[key]);
    }

    const url = this.options.url;
    const method = this.options.method || DEFAULT_METHOD;

    // Async Request: https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/Synchronous_and_Asynchronous_Requests
    xhr.open(method, url, true);

    xhr.withCredentials = !!this.options.withCredentials;

    if (this.options.timeout) {
      xhr.timeout = this.options.timeout;
    }

    xhr.send(form);
  }

  public abort() {
    // already run
    if (this.xhr) {
      this.xhr.abort();
    } else {
      // still pending
      this.emit('cancel');
    }
  }


  public get progressHuman() {
    return this.progress === 0 ? '-' : `${(this.progress * 100).toFixed(2)}%`;
  }

  public get speedHuman() {
    return this.speed === 0 ? '-' : `${humanFileSize(this.speed.toFixed(2), true)}/s`;
  }
}