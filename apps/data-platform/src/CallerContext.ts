/** Identity is supplied by App; it is a demo policy header, not an authenticated user session. */
import { createContext } from 'react';
import type { ActionRequestOptions } from './api.ts';
export const CallerContext = createContext<ActionRequestOptions>({});
