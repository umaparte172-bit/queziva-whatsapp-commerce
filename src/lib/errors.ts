export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode = 500,
    readonly code = 'INTERNAL_ERROR',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(what: string, id?: string) {
    super(id ? `${what} ${id} not found` : `${what} not found`, 404, 'NOT_FOUND');
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

/** Another request changed the record first (optimistic locking) or the state no longer allows the action. */
export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 409, 'CONFLICT', details);
  }
}

export class InvalidTransitionError extends AppError {
  constructor(from: string, to: string, actor: string, reason?: string) {
    super(
      `Order cannot move from ${from} to ${to} (by ${actor})${reason ? `: ${reason}` : ''}`,
      409,
      'INVALID_TRANSITION',
      { from, to, actor },
    );
  }
}
