export class AppError extends Error {
  constructor(public status: number, message: string, public code = 'REQUEST_ERROR') {
    super(message);
  }
}

export function requireText(value: unknown, name: string, max = 12_000): string {
  if (typeof value !== 'string' || !value.trim()) throw new AppError(400, `${name}を入力してください。`);
  if (value.length > max) throw new AppError(413, `${name}は${max.toLocaleString()}文字以内にしてください。`);
  return value.trim();
}
