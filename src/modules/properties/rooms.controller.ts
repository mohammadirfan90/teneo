// src/modules/properties/rooms.controller.ts
//
// Thin handlers per Phase 10 contract (spec §13.2.3).

import type { RequestHandler } from 'express';

import { ok } from '@/lib/envelope';

import type {
  CreateRoomInput,
  FlatIdParams,
  PatchRoomInput,
  PhotoIdParams,
  RequestPhotoUploadInput,
  RoomIdParams,
  TransitionRoomInput,
} from './rooms.schemas';
import * as svc from './rooms.service';

export const createRoom: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const roles = req.user!.roles;
  const { flatId } = req.params as unknown as FlatIdParams;
  const body = req.body as CreateRoomInput;
  const data = await svc.createRoom(flatId, userId, roles, body);
  res.status(201).json(ok(data, 'Room created'));
};

export const getRoom: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const roles = req.user!.roles;
  const { id } = req.params as unknown as RoomIdParams;
  const data = await svc.getRoom(id, userId, roles);
  res.status(200).json(ok(data, 'Room retrieved'));
};

export const patchRoom: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const roles = req.user!.roles;
  const { id } = req.params as unknown as RoomIdParams;
  const body = req.body as PatchRoomInput;
  const data = await svc.patchRoom(id, userId, roles, body);
  res.status(200).json(ok(data, 'Room updated'));
};

export const publishRoom: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const roles = req.user!.roles;
  const { id } = req.params as unknown as RoomIdParams;
  const data = await svc.publishRoom(id, userId, roles);
  res.status(200).json(ok(data, 'Room published'));
};

export const transitionRoom: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const roles = req.user!.roles;
  const { id } = req.params as unknown as RoomIdParams;
  const body = req.body as TransitionRoomInput;
  const data = await svc.transitionRoom(id, userId, roles, body);
  res.status(200).json(ok(data, 'Room transitioned'));
};

export const requestPhotoUpload: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const roles = req.user!.roles;
  const { id } = req.params as unknown as RoomIdParams;
  const body = req.body as RequestPhotoUploadInput;
  const data = await svc.requestPhotoUpload(id, userId, roles, body);
  res.status(200).json(ok(data, 'Photo upload URL issued'));
};

export const deletePhoto: RequestHandler = async (_req, _res) => {
  // Throws 501 — caught by asyncHandler.
  svc.deletePhotoStub();
};

export const reorderPhoto: RequestHandler = async (_req, _res) => {
  // Throws 501 — caught by asyncHandler.
  svc.reorderPhotoStub();
};

// Silence the unused `PhotoIdParams` import — it's referenced in the
// route file directly.
export type { PhotoIdParams };
