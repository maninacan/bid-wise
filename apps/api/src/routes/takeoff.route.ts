import express, { Router } from 'express';
import { generateTakeoffHandler } from '../generate-takeoff';

/** Router for takeoff generation. Streams NDJSON, so it lives outside GraphQL. */
export const takeoffRouter = Router();

takeoffRouter.post('/', express.json({ limit: '1mb' }), generateTakeoffHandler);
