export const read = id => {
  const fallback = () => soda({"$where":`request_id='${String(id).replace(/'/g,"''")}'`,"$limit":"1"},5e3);
  return workerFetch("/notice?id="+encodeURIComponent(id),null,5e3)
    .then(r => r.json()).then(x => x.row ? [x.row] : fallback()).catch(fallback);
};
