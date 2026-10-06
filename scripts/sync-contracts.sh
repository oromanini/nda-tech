#!/usr/bin/env bash
# Copia do deal-alluztech/contracts (fonte da verdade) só o que o nda-form usa. Rode quando o contrato mudar.
set -euo pipefail
ORIGEM="${1:-../deal-alluztech/contracts}"
DESTINO="$(dirname "$0")/../contracts"
mkdir -p "$DESTINO"/{comandos,eventos,exemplos/comandos,exemplos/eventos}
cp "$ORIGEM/comum.schema.json" "$DESTINO/"
cp "$ORIGEM/comandos/nda.convite.criar.schema.json" "$DESTINO/comandos/"
cp "$ORIGEM"/eventos/*.schema.json "$DESTINO/eventos/"
cp "$ORIGEM/exemplos/comandos/nda.convite.criar.json" "$DESTINO/exemplos/comandos/"
cp "$ORIGEM"/exemplos/eventos/nda.*.json "$DESTINO/exemplos/eventos/"
