import express, { Router } from 'express';
import { generateTakeoffHandler, cancelTakeoffHandler } from '../generate-takeoff';

/** Router for takeoff generation. Streams NDJSON, so it lives outside GraphQL. */
export const takeoffRouter = Router();

takeoffRouter.post('/', express.json({ limit: '1mb' }), generateTakeoffHandler);

/** Router for cancelling an in-progress takeoff generation. */
export const cancelTakeoffRouter = Router();

cancelTakeoffRouter.post('/', express.json({ limit: '1mb' }), cancelTakeoffHandler);
