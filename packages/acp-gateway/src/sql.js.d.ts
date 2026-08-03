declare module "sql.js" {
  interface QueryExecResult {
    columns: string[];
    values: Array<Array<unknown>>;
  }

  interface Statement {
    bind(params: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): boolean;
  }

  class Database {
    constructor(data?: ArrayBuffer | Uint8Array);
    run(sql: string, params?: unknown[]): void;
    exec(sql: string, params?: unknown[]): QueryExecResult[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }

  interface SqlJsStatic {
    Database: typeof Database;
  }

  export default function initSqlJs(): Promise<SqlJsStatic>;
}
