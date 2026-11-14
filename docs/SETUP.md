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
| `MERCADO_PAGO_WEBHOOK_SECRET` | Segredo do HMAC `x-signature`; obrigatório no webhook (fail-closed). |
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

Na Vercel, adicione as variáveis de ambiente:

| Variável | Valor |
|---|---|
| `SUPABASE_URL` | URL do seu projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key (a integração Supabase da Vercel cria com esse nome; `SUPABASE_SERVICE_KEY` também é aceito) |
| `MP_ACCESS_TOKEN` | Token do Mercado Pago (produção ou sandbox) |
| `MP_MIN_VALUE_CENTS` | Valor mínimo em centavos (ex: `500` = R$5) |
| `LIVEPIX_OAUTH_SCOPE` | `messages:read` (padrão) |

> ℹ️ **Modo SaaS:** não existem mais `LIVEPIX_CLIENT_ID`,
> `LIVEPIX_CLIENT_SECRET` nem `LIVEPIX_WEBHOOK_SECRET` globais. Cada streamer
> cola as próprias credenciais no app (Configurações → Pagamentos) e o app
> grava em `public.streamer_configs`.

> ⚠️ Rode novamente `supabase/schema.sql` depois de atualizar o app: ele cria
> `streamer_configs`, adiciona `streamer_id` em `public.queue` e habilita
> Realtime na tabela.

Após o deploy, você terá URLs como:
```
https://chessstream-webhook.vercel.app/api/webhook       (Mercado Pago)
https://chessstream-webhook.vercel.app/api/livepix       (LivePix — base)
```

---

## 6. Configurar Webhook no Mercado Pago (Opção B)

1. Acesse [mercadopago.com.br/developers](https://www.mercadopago.com.br/developers)
2. Vá em **Suas integrações → Webhooks**
3. Adicione a URL da Vercel acima
4. Marque apenas o evento **`payment`**

### Passando dados do viewer no pagamento

Quando gerar um QR Code / link de pagamento, passe o `external_reference` com o formato:
```
twitch:NomeDoViewer:nick_chess_do_viewer
```

Exemplo via API MP:
```js
{
  external_reference: "twitch:Joaozinho:joao_chess",
  transaction_amount: 10.00,
  ...
}
```

---

## 6.1. Configurar Webhook no LivePix (SaaS / multi-streamer)

1. Cada streamer cria a própria aplicação no painel de desenvolvedores da
   LivePix e copia `client_id`/`client_secret`.
2. No app, abra **Configurações → Pagamentos**, preencha **LivePix Client ID**
   e **LivePix Client Secret** e clique em **Salvar**.
3. O app:
   - gera um `streamer_id` único (UUID) para a instalação;
   - gera um `webhook_secret` aleatório;
   - publica as credenciais em `public.streamer_configs` via RPC;
   - exibe a **URL de Webhook** pronta.
4. Copie a URL exibida (botão **Copiar**) e cole no painel do LivePix:

```
https://<seu-projeto>.vercel.app/api/livepix?streamer=<streamer_id>&secret=<webhook_secret>
```

5. O espectador doa pelo LivePix com a mensagem `!jogar <nick_chess>`
   (ex.: `Manda bala, !jogar Hikaru`).
6. O webhook identifica o streamer pela URL, busca o `client_secret` em
   `streamer_configs`, autentica na LivePix via OAuth2
   (`client_credentials`), consulta `GET /v2/messages/{id}` e insere em
   `public.queue` com `streamer_id`, `status = 'pending'` e `priority = 'vip'`.
7. O app recebe via Realtime apenas os eventos com o seu `streamer_id`.

> O webhook da LivePix envia apenas o `id` do recurso; por isso o endpoint
> autentica via OAuth2 e consulta `GET /v2/messages/{id}`.

> 🔐 A tabela `streamer_configs` tem RLS sem policies: a anon key do app não
> consegue ler os segredos. A gravação é feita pela função
> `register_streamer_config()` e a leitura pelo webhook com `service_role`.

### Migração de instalações antigas

Linhas de fila criadas antes do modo SaaS têm `streamer_id = NULL` e não
aparecem para uma instalação já configurada. Para reaproveitar a fila atual:

```sql
UPDATE public.queue
SET streamer_id = '<streamer_id exibido no app>'
WHERE streamer_id IS NULL;
```

> Em produção, recomenda-se evoluir o isolamento para JWTs por streamer
> (Supabase Auth), porque a anon key é compartilhada por todas as instalações.
> O filtro por `streamer_id` isola a interface e o Realtime, mas não impede
> leitura direta da tabela por quem possui essa chave.

---

## 7. Testar o fluxo completo (Opção B)

1. Rode o app: `npm start`
2. No Supabase → SQL Editor, insira uma linha manualmente para simular pagamento:

```sql
INSERT INTO fila_vip (payment_id, username, chess_nick, platform, amount_cents)
VALUES ('test-001', 'Joaozinho', 'joao_chess123', 'twitch', 1000);
```

3. O painel deve tocar o som e mostrar o toast VIP em ~1 segundo.

---

## Comandos do chat

| Comando | Quem usa | Efeito |
|---|---|---|
| `!jogar <nick>` | Viewer | Entra na fila |
| `!posicao` | Viewer | Vê sua posição |
| `!sair` | Viewer | Sai da fila |
| `!proximo` | Streamer/Mod | Puxa próximo da fila e abre Chess.com |
| `!pular` | Streamer/Mod | Move atual para o fim, puxa próximo |
| `!fila pausar` | Streamer/Mod | Para novas entradas |
| `!fila retomar` | Streamer/Mod | Reabre a fila |

---

## Sistema de prioridades

| Cor da barra | Nível | Quem |
|---|---|---|
| Verde | Ultra VIP (1) | Convidado direto do streamer |
| Dourado | VIP Pago (2) | Doação via Pix / assinante |
| Azul | Membro (3) | Sub Twitch / membro YouTube |
| Sem barra | Padrão (4) | Viewer comum |

Veja [OPERATIONS.md](OPERATIONS.md) para os comandos e o checklist de transmissão.
