# 🛠️ Setup — ChessStream Hub

## Pré-requisitos

- Node.js/npm em versões compatíveis com a versão Electron declarada no `package.json`.
- Projeto Supabase para fila persistida e sincronização VIP.
- Credenciais OAuth da Google para YouTube, quando essa integração for utilizada.
- Aplicativo Twitch Developer e canal Twitch, quando essa integração for utilizada.
- Conta TikTok e, opcionalmente, cookie `sessionid`.
- Conta Mercado Pago e projeto Vercel somente para ativar o fluxo VIP.

## 1. Instalar dependências

```bash
git clone https://github.com/Lapllace/ChessStream.git
cd ChessStream
npm install
```

## 2. Configurar ambiente

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

macOS / Linux:

```bash
cp .env.example .env
```

Preencha as variáveis de `.env.example` que correspondem às integrações utilizadas:

| Variável | Finalidade |
|---|---|
| `CHESS_STREAMER_NICK` | Nick do streamer no Chess.com. |
| `TWITCH_USERNAME` | Usuário do bot Twitch. |
| `TWITCH_OAUTH_TOKEN` | Token do bot; o código normaliza o prefixo `oauth:`. |
| `TWITCH_CHANNEL` | Canal conectado. |
| `TIKTOK_USERNAME` | Usuário da live TikTok. |
| `TIKTOK_SESSION_ID` | Cookie opcional para lives que exigem sessão. |
| `YOUTUBE_CHANNEL_ID` | ID do canal YouTube. |
| `YOUTUBE_LIVE_CHAT_ID` | ID opcional do chat ao vivo; o módulo pode tentar descobrir uma live ativa. |
| `SUPABASE_URL` | URL do projeto Supabase. |
| `SUPABASE_ANON_KEY` | Chave pública anon do Supabase. |
| `MP_ACCESS_TOKEN` | Token do Mercado Pago para o webhook. |
| `MP_WEBHOOK_SECRET` | Segredo reservado para validação do webhook; confira o estado da implementação antes de produção. |
| `MP_MIN_VALUE_CENTS` | Valor mínimo em centavos para pagamento VIP. |

As configurações também podem ser feitas pelo painel, quando a opção estiver disponível. Nunca coloque valores reais no `.env.example`.

## 3. Preparar Supabase

1. Crie um projeto em [supabase.com](https://supabase.com/).
2. Abra **SQL Editor**.
3. Revise o arquivo `supabase/schema.sql`.
4. Execute o SQL em projeto de desenvolvimento.
5. Copie Project URL e chave anon para o arquivo local `.env`.
6. Confirme Realtime para `fila_vip`.

> **Segurança:** as policies no schema concedem permissões amplas a roles públicas. Leia [SECURITY.md](SECURITY.md) e ajuste as policies antes de produção.

## 4. YouTube OAuth

1. Abra [Google Cloud Console](https://console.cloud.google.com/).
2. Ative YouTube Data API v3.
3. Crie credenciais OAuth para aplicativo desktop.
4. Baixe o JSON de credenciais.
5. Coloque o arquivo no local esperado pelo carregador de credenciais em `src/main/index.js`.
6. Compare o nome do arquivo com a lista `build.files` de `package.json` antes de empacotar: o caminho do runtime e o do empacotamento precisam coincidir.
7. Inicie a autenticação pela tela de configurações do aplicativo.

O módulo consulta `liveChatMessages.list` em ciclos de 15 segundos e descarta mensagens anteriores ao início da conexão.

## 5. Twitch

1. Crie um aplicativo no [Twitch Developer Console](https://dev.twitch.tv/console/apps).
2. Configure `TWITCH_CHANNEL`, `TWITCH_USERNAME` e as credenciais necessárias.
3. Use a opção de conexão Twitch no aplicativo, quando disponível.
4. Confira o status no painel e faça teste com um canal privado/de teste.

## 6. TikTok

1. Informe o usuário sem `@` em `TIKTOK_USERNAME`.
2. Teste a conexão anônima.
3. Se a live exigir autenticação, use o fluxo de conexão disponível ou configure o `TIKTOK_SESSION_ID` localmente.
4. Nunca compartilhe ou faça commit do cookie.

## 7. Mercado Pago + Vercel (opcional)

A pasta `vercel-webhook/` contém a função `api/webhook.js`.

1. Faça deploy da função na Vercel.
2. Configure `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `MP_ACCESS_TOKEN` e `MP_MIN_VALUE_CENTS` como secrets do projeto.
3. Configure o webhook no painel do Mercado Pago para evento de pagamento.
4. Garanta que o fluxo de assinatura do webhook foi implementado e testado antes de usar pagamentos reais.

O `external_reference` atualmente é interpretado como `plataforma:usuario:nick_chess`. O handler consulta o pagamento na API do Mercado Pago e só processa pagamentos aprovados acima do mínimo.

## 8. Executar

```bash
npm start
```

Para gerar instalador:

```bash
npm run build
```

Veja [OPERATIONS.md](OPERATIONS.md) para os comandos e o checklist de transmissão.
