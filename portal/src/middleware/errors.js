'use strict';

const { AppError } = require('../lib/errors');

function notFoundHandler(req, res) {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
}

/** Converts any thrown error into the standard JSON envelope without leaking internals. */
function errorHandler(logger) {
   
  return (err, req, res, _next) => {
    if (err instanceof AppError) {
      if (err.status >= 500) logger.error({ err, path: req.path }, err.message);
      return res.status(err.status).json({
        success: false,
        error: { code: err.code, message: err.message, details: err.details ?? [] },
      });
    }
    // Multer upload errors.
    if (err && err.name === 'MulterError') {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'The file is too large' : 'File upload failed';
      return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
        success: false,
        error: { code: 'UPLOAD_ERROR', message },
      });
    }
    // Body parser errors.
    if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
      return res.status(err.type === 'entity.too.large' ? 413 : 400).json({
        success: false,
        error: { code: 'BAD_REQUEST', message: 'Invalid request body' },
      });
    }
    logger.error({ err, path: req.path, method: req.method }, 'unhandled error');
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. The error has been logged.' },
    });
  };
}

module.exports = { notFoundHandler, errorHandler };
