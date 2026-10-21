import type { InventoryBridge } from '../../../packages/contracts/index';
import { createDesktopClient, createHttpClient } from './transport';
declare global { interface Window { inventory?: InventoryBridge } }
export const client = window.inventory ? createDesktopClient(window.inventory) : createHttpClient();
