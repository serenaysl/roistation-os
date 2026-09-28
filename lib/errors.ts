export class ApiError extends Error {
  constructor(message:string,public status=400) {super(message);}
}
/** Raised only when optimistic concurrency on ONE Blob object keeps losing after a small, bounded number of attempts. */
export class StorageBusyError extends ApiError {
  constructor(message="Kayıt aynı anda başka bir işlemle güncellendi. Claude kredisi harcamadan aynı düğmeye bir kez daha bas.") {super(message,409);}
}
export function apiFailure(error:unknown) {
  return Response.json({error:error instanceof ApiError ? error.message : "İşlem tamamlanamadı."},{status:error instanceof ApiError ? error.status : 500,headers:{"Cache-Control":"no-store"}});
}
