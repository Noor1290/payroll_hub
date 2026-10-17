// Adapts a real Supabase client to the small interface the checks use (src/safety/nonmemberChecks.ts,
// `Api`). Every answer is reduced to { data, error, count }; errors keep only code, message, status.

const errorOf = (error) =>
  error ? { code: error.code ?? undefined, message: error.message ?? String(error), status: error.status ?? error.statusCode } : null;

const done = ({ data, error, count }) => ({ data, error: errorOf(error), count: count ?? null });

function applyFilters(query, filters) {
  let next = query;
  for (const filter of filters) next = filter.op === "in" ? next.in(filter.column, filter.value) : next.eq(filter.column, filter.value);
  return next;
}

export function supabaseApi(client) {
  const bucket = (id) => client.storage.from(id);
  return {
    read: async (table) => done(await client.from(table).select("*", { count: "exact" }).limit(5)),
    insert: async (table, row) => done(await client.from(table).insert(row)),
    update: async (table, values, filters) => done(await applyFilters(client.from(table).update(values, { count: "exact" }), filters)),
    remove: async (table, filters, limitOneBy) => {
      let query = applyFilters(client.from(table).delete({ count: "exact" }), filters);
      if (limitOneBy) query = query.order(limitOneBy).limit(1);
      return done(await query);
    },
    rpc: async (name, args) => done(await client.rpc(name, args)),
    storageList: async (id, prefix) => done(await bucket(id).list(prefix, { limit: 5 })),
    storageDownload: async (id, path) => done(await bucket(id).download(path)),
    storageUpload: async (id, path, bytes) =>
      done(await bucket(id).upload(path, bytes, { contentType: "application/pdf", upsert: false })),
    storageUpdate: async (id, path, bytes) => done(await bucket(id).update(path, bytes, { contentType: "application/pdf" })),
    storageRemove: async (id, paths) => done(await bucket(id).remove(paths)),
    listBuckets: async () => done(await client.storage.listBuckets()),
    getBucket: async (id) => done(await client.storage.getBucket(id)),
  };
}
