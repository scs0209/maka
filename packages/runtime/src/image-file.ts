/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { stat, readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { imageDimensionsFromData } from 'image-dimensions';
import {
  MAX_MODEL_IMAGE_EDGE,
  MAX_READ_IMAGE_BYTES,
  READ_IMAGE_TOO_LARGE_MESSAGE,
  sniffAttachmentMimeType,
} from '@maka/core/attachments';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export function isSupportedImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

export async function readWorkspaceImage(
  path: string,
): Promise<{ bytes: Uint8Array; mimeType: ImageMimeType }> {
  const size = await stat(path).catch(() => {
    throw new Error('Image could not be read.');
  });
  if (!size.isFile()) throw new Error('Image path is not a file.');
  if (size.size > MAX_READ_IMAGE_BYTES) throw imageTooLargeError();
  const bytes = await readFile(path).catch(() => {
    throw new Error('Image could not be read.');
  });
  return validateImageBytes(bytes);
}

/** Pixel dimensions read from an image's header, or nothing when unreadable. */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const dimensions = imageDimensionsFromData(bytes);
  return dimensions &&
    Number.isSafeInteger(dimensions.width) &&
    Number.isSafeInteger(dimensions.height) &&
    dimensions.width > 0 &&
    dimensions.height > 0 &&
    Math.max(dimensions.width, dimensions.height) <= MAX_MODEL_IMAGE_EDGE
    ? { width: dimensions.width, height: dimensions.height }
    : undefined;
}

const materializedImageSizes = new WeakMap<object, { width: number; height: number }>();

/**
 * Remember what a materialized image will bill, at the one place that still has
 * its bytes. A materialized `file` part reaches the provider as base64 and
 * carries no dimensions of its own, so a payload measure that reads only the
 * part must otherwise price every image at the admission bound — a second ruler
 * disagreeing with the ledger's area-based one.
 */
export function rememberMaterializedImageSize(
  part: object,
  bytes: Uint8Array,
  recorded?: { width?: number; height?: number },
): void {
  const size =
    recorded?.width !== undefined && recorded.height !== undefined
      ? { width: recorded.width, height: recorded.height }
      : imageDimensions(bytes);
  if (size) materializedImageSizes.set(part, size);
}

/** The remembered size of a materialized image part, absent when never seen. */
export function materializedImageSize(part: object): { width: number; height: number } | undefined {
  return materializedImageSizes.get(part);
}

export function validateImageBytes(bytes: Uint8Array): {
  bytes: Uint8Array;
  mimeType: ImageMimeType;
} {
  if (bytes.length > MAX_READ_IMAGE_BYTES) throw imageTooLargeError();
  const mimeType = sniffImageMime(bytes);
  if (!mimeType) throw new Error('Image content is not a supported PNG, JPEG, GIF, or WebP file.');
  const dimensions = imageDimensionsFromData(bytes);
  if (
    !dimensions ||
    !Number.isFinite(dimensions.width) ||
    !Number.isFinite(dimensions.height) ||
    !Number.isInteger(dimensions.width) ||
    !Number.isInteger(dimensions.height) ||
    dimensions.width <= 0 ||
    dimensions.height <= 0
  ) {
    throw new Error('Image dimensions could not be read; verify the image file is valid.');
  }
  if (Math.max(dimensions.width, dimensions.height) > MAX_MODEL_IMAGE_EDGE) {
    throw new Error(
      `Image dimensions ${dimensions.width}x${dimensions.height} exceed the ${MAX_MODEL_IMAGE_EDGE}px model input limit; downscale it and try again.`,
    );
  }
  return { bytes, mimeType };
}

function imageTooLargeError(): Error {
  return new Error(READ_IMAGE_TOO_LARGE_MESSAGE);
}

function sniffImageMime(bytes: Uint8Array): ImageMimeType | undefined {
  // Core owns the byte signatures (shared with the attachment and artifact
  // paths); this reader decodes only images, so a sniffed PDF is not one here.
  const sniffed = sniffAttachmentMimeType(bytes);
  return sniffed && sniffed !== 'application/pdf' ? sniffed : undefined;
}
