#!/usr/bin/env bash
# scripts/qa-ui.sh — sobe um http server local pra abrir o qa-ui.html no browser.
# Por que não abrir direto via file://? Porque o navegador bloqueia fetch() com CORS
# em origin null (file://). Servindo via http://localhost a CORS do backend funciona.
#
# Uso:
#   ./scripts/qa-ui.sh             # porta 4173
#   PORT=4174 ./scripts/qa-ui.sh   # outra porta
#
# Requer: python3 OU node (qualquer um serve).

set -u
PORT="${PORT:-4173}"
DIR="$(cd "$(dirname "$0")" && pwd)"
URL="http://localhost:$PORT/qa-ui.html"

# Cores
G=$'\e[32m'; B=$'\e[36m'; Y=$'\e[33m'; N=$'\e[0m'

echo "${B}KairoBarber QA UI${N}"
echo "  serving:  $DIR"
echo "  url:      ${G}$URL${N}"
echo "  ${Y}ctrl+c pra parar${N}"
echo

# Abre o browser depois de 1s (em background)
(sleep 1 && {
  if command -v xdg-open >/dev/null; then xdg-open "$URL"
  elif command -v open >/dev/null; then open "$URL"
  elif command -v wslview >/dev/null; then wslview "$URL"
  else echo "abra manualmente: $URL"
  fi
} 2>/dev/null) &

# Escolhe um http server disponível
if command -v python3 >/dev/null; then
  # bind em 0.0.0.0 pra aceitar tanto localhost quanto 127.0.0.1 (CORS distingue os dois)
  cd "$DIR" && exec python3 -m http.server "$PORT"
elif command -v node >/dev/null; then
  # Servidor mínimo em Node
  exec node -e "
    const http=require('http'), fs=require('fs'), path=require('path');
    const dir='$DIR';
    http.createServer((req,res)=>{
      const f = path.join(dir, req.url === '/' ? 'qa-ui.html' : req.url);
      fs.readFile(f, (e,d)=>{
        if(e){res.writeHead(404).end('not found');return;}
        const ext = path.extname(f);
        const ct = ext==='.html'?'text/html':ext==='.js'?'application/javascript':ext==='.css'?'text/css':'application/octet-stream';
        res.writeHead(200,{'Content-Type':ct}).end(d);
      });
    }).listen($PORT, '127.0.0.1', ()=>console.log('listening on $PORT'));
  "
else
  echo "${Y}precisa de python3 ou node instalado${N}"
  exit 2
fi
