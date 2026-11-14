# 🎛 Operations — ChessStream Hub

## Inicialização

1. Abra o aplicativo com `npm start`.
2. Confirme que o Supabase está configurado e acessível.
3. Conecte as plataformas necessárias nas configurações.
4. Confirme os indicadores de conexão no painel.
5. Faça um teste com uma conta de espectador antes de iniciar uma transmissão real.

## Comandos de espectador

| Comando | Resultado |
|---|---|
| `!jogar <nick>` | Solicita entrada na fila após validação do nick Chess.com. |
| `!posicao` | Consulta a posição atual. |
| `!sair` | Solicita remoção da fila. |

## Comandos administrativos

Os comandos administrativos abaixo são processados pelo adaptador Twitch:

| Comando | Resultado |
|---|---|
| `!proximo` | Chama o próximo participante. |
| `!pular` | Move o participante atual para o fim e chama o próximo. |
| `!fila pausar` | Bloqueia novas entradas. |
| `!fila retomar` | Permite novas entradas novamente. |

O painel desktop também possui controles de gerenciamento. As permissões de streamer/moderação devem ser testadas no canal de teste antes da live.

## Monitoramento

- **YouTube:** polling de mensagens a cada 15 segundos.
- **Chess.com:** polling de partidas a cada 20 segundos.
- **TikTok:** tentativa normal de reconexão após 30 segundos; quando identifica rate limit, aumenta a espera para 5 minutos.
- **Rede:** os módulos de YouTube e Chess.com usam backoff exponencial em falhas de rede, com limite de 60 segundos.

## Scripts npm

| Script | Uso |
|---|---|
| `npm start` | Inicia Electron. |
| `npm run dev` | Inicia com `NODE_ENV=development`; o script atual usa sintaxe POSIX. |
| `npm run build` | Executa electron-builder. |
| `npm run build:electron` | Alias do build. |

No Windows, o script `dev` pode exigir ajuste para definir `NODE_ENV`; `npm start` permanece como o comando simples de execução.

## Checklist antes de uma transmissão

- [ ] Supabase conectado.
- [ ] Canal Twitch, YouTube e/ou TikTok correto.
- [ ] Tokens e sessão válidos.
- [ ] Nick do streamer no Chess.com correto.
- [ ] Fila vazia ou no estado esperado.
- [ ] Teste de `!jogar`, `!posicao` e `!sair`.
- [ ] Áudio e alertas revisados.
- [ ] Credenciais fora do Git e não compartilhadas em capturas de tela.

