// src/modules/properties/rooms.controller.ts
//
// Thin handlers per Phase 10 contract (spec §13.2.3).

import type { RequestHandler } from 'express';

import { isStorageEnabled } from '@/lib/cloudinary';
import { ok } from '@/lib/envelope';
import { StorageDisabledError } from '@/lib/errors';
import { assertMagicBytes, requireFile } from '@/middleware/upload';

import type {
  CreateRoomInput,
  FlatIdParams,
  PatchRoomInput,
  PhotoIdParams,
  ReorderPhotoInput,
  RoomIdParams,
  TransitionRoomInput,
  UploadPhotoInput,
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

/** 503 before any DB work when Cloudinary credentials are absent. */
function assertStorageEnabled(): void {
  if (!isStorageEnabled()) throw new StorageDisabledError();
}

export const uploadPhoto: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const roles = req.user!.roles;
  const { id } = req.params as unknown as RoomIdParams;

  // Request validation comes first: a bad upload is a 400 regardless of
  // whether this environment happens to have storage credentials.
  const file = requireFile(req.file);
  // The declared Content-Type is caller-supplied; check the bytes agree
  // before spending an upload on it.
  assertMagicBytes(file);

  assertStorageEnabled();

  const data = await svc.uploadRoomPhoto(id, userId, roles, {
    fields: req.body as UploadPhotoInput,
    file: { buffer: file.buffer, mimetype: file.mimetype, size: file.size },
  });
  res.status(201).json(ok(data, 'Photo uploaded'));
};

export const listPhotos: RequestHandler = async (req, res) => {
  const { id } = req.params as unknown as RoomIdParams;
  const data = await svc.listRoomPhotos(id);
  res.status(200).json(ok(data, 'Photos retrieved'));
};

export const deletePhoto: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const roles = req.user!.roles;
  const { id, photoId } = req.params as unknown as PhotoIdParams;
  const data = await svc.deleteRoomPhoto(id, photoId, userId, roles);
  res.status(200).json(ok(data, 'Photo deleted'));
};

export const reorderPhoto: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const roles = req.user!.roles;
  const { id, photoId } = req.params as unknown as PhotoIdParams;
  const { position } = req.body as ReorderPhotoInput;
  const data = await svc.reorderRoomPhoto(id, photoId, userId, roles, position);
  res.status(200).json(ok(data, 'Photos reordered'));
};
