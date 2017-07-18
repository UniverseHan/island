import { StatusExporter } from 'island-status-exporter';

// TODO 정상적으로 고쳐야 한다.
export const STATUS_EXPORT: boolean = process.env.STATUS_EXPORT === 'true' || true;
export const STATUS_EXPORT_TIME_MS: number = parseInt(process.env.STATUS_EXPORT_TIME, 10) | 3 * 1000;
const STATUS_FILE_NAME: string = process.env.STATUS_FILE_NAME;

StatusExporter.initialize(STATUS_EXPORT, STATUS_FILE_NAME);

export const exporter = StatusExporter;
