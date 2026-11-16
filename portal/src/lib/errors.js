'use strict';

/** Application error that maps cleanly onto the JSON error envelope. */
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (msg, details) => new AppError(400, 'BAD_REQUEST', msg, details);
const validation = (msg, details) => new AppError(422, 'VALIDATION_ERROR', msg, details);
const unauthorized = (msg = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', msg);
const forbidden = (msg = 'You do not have permission to do that') => new AppError(403, 'FORBIDDEN', msg);
const notFound = (msg = 'Not found') => new AppError(404, 'NOT_FOUND', msg);
const conflict = (msg, details) => new AppError(409, 'CONFLICT', msg, details);
const upstream = (msg, details) => new AppError(502, 'UPSTREAM_ERROR', msg, details);

/** Parses `data` with a zod schema, throwing a 422 with field details on failure. */
function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw validation(
      'Some fields are invalid',
      r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

module.exports = { AppError, badRequest, validation, unauthorized, forbidden, notFound, conflict, upstream, parse };
