'use strict';

let canvas;
try {
  canvas = require('@napi-rs/canvas');
} catch (primaryError) {
  try {
    canvas = require('canvas');
  } catch (fallbackError) {
    const error = new Error(
      'No canvas backend is installed. Run npm install. ' +
      `@napi-rs/canvas: ${primaryError.message}; canvas: ${fallbackError.message}`
    );
    error.cause = fallbackError;
    throw error;
  }
}

module.exports = canvas;
