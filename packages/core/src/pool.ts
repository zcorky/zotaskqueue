import { Event } from '@zodash/event';
import { IWorker } from './worker';

export interface IPool {
  /**
   * Create Worker Into Pool
   * 
   * @param W Worker Class
   * @param options Worker Options
   */
  create<P>(W: IWorker<P>, options: P): Promise<IWorker<P>>;

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
   * Clear Worker Pool
   */
  clear(): Promise<void>;

  /**
   * Map Worker
   */
  map(fn: (worker: IWorker) => any): IWorker[]; 
}

export interface PoolOptions {
  capacity: number;
}

export class Pool extends Event implements IPool {
  private cache: Record<string, IWorker> = {};

  constructor(public readonly options: PoolOptions) {
    super();
  }

  public async create<P>(W: IWorker<P>, options: P) {
    const worker = new (W as any)(options);
    
    this.cache[worker.id] = worker;

    this.emit('create', worker);

    return worker; // @TODO
  }

  public async get<P>(id: string): Promise<IWorker<P>> {
    const worker = this.cache[id] || null;

    this.emit('get', worker);

    return worker;
  }

  public async remove(id: string) {
    const worker = this.cache[id];

    this.emit('remove', worker);

    delete this.cache[id];
  }

  public async clear() {
    this.emit('clear');

    for (const id in this.cache) {
      delete this.cache[id];
    }
  }

  public map<T>(fn: (worker: IWorker) => T): T[] {
    const _t: T[] = [];
    
    for (const key in this.cache) {
      _t.push(fn(this.cache[key]));
    }

    return _t;
  }
}