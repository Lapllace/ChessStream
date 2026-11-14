# Política de Privacidade — ChessStream Hub

**Última atualização:** 13 de novembro de 2026
**Controlador:** Tenebris (doravante "nós", "Licenciante")
**Produto:** ChessStream Hub — aplicativo desktop para gerenciamento de filas e
transmissões de xadrez.

Esta Política descreve quais dados o ChessStream Hub trata, por quê, onde ficam
armazenados e como o usuário pode exercer seus direitos. Ela complementa os
[Termos de Uso e Licença](../LICENSE.txt) e observa a Lei Geral de Proteção de
Dados (Lei nº 13.709/2018 — LGPD).

> **Resumo:** o aplicativo funciona localmente no computador do streamer. As
> credenciais sensíveis ficam cifradas no disco pelo `safeStorage` do sistema
> operacional. A licença é validada exclusivamente pela chave mensal
> (`CSH-XXXX-XXXX-XXXX`) e pela data de expiração, **sem qualquer identificação
> de hardware**. Os dados de fila e histórico são gravados no Supabase
> configurado pelo próprio streamer. Não vendemos, alugamos nem usamos dados para
> publicidade.

---

## 1. Quem é o controlador e quem é o operador

1.1. O **streamer** (usuário licenciado) é o controlador dos dados de seus
espectadores que insere ou coleta por meio do aplicativo — por exemplo, nomes de
jogadores, nicks de xadrez e histórico de partidas.

1.2. A **Tenebris** atua como desenvolvedora e licenciante do software. Ela
recebe apenas os dados estritamente necessários para ativar e validar a licença
de uso, além de dados técnicos agregados de atualização.

1.3. O streamer é responsável por informar seus espectadores sobre o uso do bot
em seu chat/canal e por atender solicitações de titulares relativas aos dados
que ele próprio controla.

---

## 2. Dados armazenados localmente no dispositivo

O aplicativo utiliza `electron-store` no perfil do usuário
(`%APPDATA%/chessstream-hub` no Windows) para guardar configurações e
credenciais.

| Dado | Finalidade | Proteção |
| --- | --- | --- |
| Token OAuth da Twitch | Ler e enviar mensagens no chat | Cifrado via `safeStorage` |
| Tokens de acesso/refresh do YouTube | Integração com a API do YouTube | Cifrado via `safeStorage` |
| Session ID do TikTok | Conectar ao chat ao vivo do TikTok | Cifrado via `safeStorage` |
| Access token do Mercado Pago | Consultar pagamentos aprovados | Cifrado via `safeStorage` |
| Client secret e webhook secret do LivePix | Validar webhooks de doação | Cifrado via `safeStorage` |
| Segredo de propriedade do streamer | Autorizar alterações da instalação no cadastro central | Cifrado via `safeStorage` |
| Chave de licença | Ativação e identificação da licença | Cifrado via `safeStorage` |
| URL e anon key do Supabase | Conectar ao banco do próprio streamer | Texto simples (chave pública do projeto) |
| Nick do streamer, preferências, layout do overlay, flags de fila | Funcionamento do app | Texto simples (não sensível) |
| Estado da licença (status, expiração, última validação) | Controle de validade e tolerância offline | Texto simples (dado técnico não sensível) |

2.1. **Criptografia com `safeStorage`.** Antes de gravar, segredos são cifrados
pela API `safeStorage` do Electron, que usa o cofre do sistema operacional
(DPAPI/Credential Manager no Windows, Keychain no macOS, libsecret no Linux). O
disco recebe apenas o texto cifrado em Base64, prefixado com `enc:v1:`.

2.2. **Limitação importante.** Se o sistema operacional não oferecer criptografia
disponível, o aplicativo mantém compatibilidade gravando o valor sem cifra. Nesse
caso, o risco é do ambiente do usuário; recomenda-se manter o SO atualizado e o
acesso físico ao computador protegido por senha.

2.3. **Nada é enviado para a Tenebris a partir desses campos**, com exceção da
chave de licença, transmitida exclusivamente ao servidor de licenças para
ativação/validação (ver seção 3). Tokens e secrets permanecem no computador,
exceto quando a própria integração de terceiros exige a chamada autenticada (por
exemplo, a API da Twitch).

---

## 3. Licenciamento por chave (sem vínculo de máquina)

3.1. O ChessStream Hub é licenciado por **assinatura mensal**. O Licenciante gera
manualmente uma chave no formato `CSH-XXXX-XXXX-XXXX`, com validade de **30 dias**
contados a partir da primeira ativação.

3.2. A licença **não é vinculada a hardware**. Não calculamos, não armazenamos e
não transmitimos identificadores de máquina (HWID, UUID, MAC ou similares). O
streamer pode trocar de computador e reutilizar a mesma chave, desde que ela
esteja dentro do prazo de validade.

3.3. Para ativar e validar a licença, o aplicativo envia ao endpoint de licenças
hospedado na Vercel **apenas**:

- a chave de licença digitada;
- a ação solicitada (`activate` na primeira utilização ou validação nas
  seguintes).

O endpoint responde com o status (`active`, `expired` ou `revoked`), a data de
expiração e os dias restantes. O servidor registra ainda a data da última
verificação (`last_check_at`), usada apenas para suporte e auditoria.

3.4. A validação online ocorre no máximo a cada 3 dias, de forma silenciosa. O
aplicativo mantém um cache local da data de expiração para continuar funcionando
temporariamente sem internet, até o prazo da licença. Nenhum dado de uso, de fila
ou de chat é enviado ao servidor de licenças.

3.5. A chave e o estado da licença ficam registrados na tabela `licenses` do
projeto Supabase do Licenciante, acessível apenas pelo servidor de licenças com
credenciais administrativas (`service_role`). O aplicativo cliente nunca acessa
essa tabela diretamente.

---

## 4. Dados enviados ao Supabase configurado pelo streamer

O aplicativo não possui banco de dados próprio na nuvem da Tenebris para a
operação do bot. O streamer informa a URL e a `anon key` do **seu próprio projeto
Supabase**, e o app grava/consulta:

| Tabela | Dados | Finalidade |
| --- | --- | --- |
| `queue` | nick do jogador, nick de xadrez, plataforma (chess.com/Lichess/etc.), status, posição, prioridade, notas, `streamer_id` | Manter a fila de partidas sincronizada |
| `match_history` | `queue_id`, nome do jogador, nome do oponente, resultado, URL/ID da partida | Histórico de partidas exibido no app |
| `streamer_config` | identificação do streamer e configuração de webhook do LivePix | Receber notificações de doação |

4.1. Esses dados são gravados no projeto Supabase **do streamer**, sob sua
responsabilidade e conforme a política de privacidade que ele mantiver. Quando
a operação utiliza a infraestrutura centralizada da Tenebris, aplica-se também
o acesso administrativo controlado descrito na seção 9.3, limitado às
finalidades de suporte, manutenção, auditoria de segurança e prevenção a
fraudes.

4.2. O app pode ler mensagens públicas de chat (Twitch, TikTok, YouTube) para
identificar comandos de entrada na fila. Apenas o necessário para a funcionalidade
é processado: nome de usuário, texto do comando e plataforma de origem.

4.3. O overlay do OBS é servido localmente (`localhost`) e não envia dados para a
internet por si só.

---

## 5. Pagamentos (LivePix e Mercado Pago)

5.1. O aplicativo **não processa, não intermedeia e não custodia pagamentos**.
Ele apenas consome APIs/webhooks dos provedores escolhidos pelo streamer para
identificar doações ou pagamentos aprovados e, opcionalmente, priorizar o
espectador na fila.

5.2. Os dados financeiros (valores, nomes, identificadores de transação, status)
trafegam entre o provedor de pagamento e o streamer. A Tenebris não recebe esses
dados.

5.3. O tratamento de dados pelo LivePix e pelo Mercado Pago é regido pelas
políticas de privacidade desses provedores. O streamer deve observar também as
obrigações fiscais e consumeristas aplicáveis.

5.4. Estornos, contestações e reembolsos são tratados diretamente entre streamer
e espectador, conforme a cláusula 6 dos Termos de Uso.

---

## 6. Atualizações automáticas

6.1. Em builds instalados, o aplicativo consulta o GitHub Releases para verificar
se há nova versão.

6.2. Nessa consulta, o GitHub pode registrar dados técnicos padrão de conexão
(endereço IP, user-agent, data/hora), conforme a política de privacidade do
GitHub. A Tenebris não recebe nem armazena esses registros.

6.3. Nenhum dado de fila, chat, credencial ou de licença é enviado durante a
verificação de atualização.

---

## 7. Compartilhamento de dados

7.1. A Tenebris **não vende, aluga ou compartilha** dados pessoais para
publicidade ou finalidades comerciais de terceiros.

7.2. O compartilhamento ocorre apenas com:

- **Servidor de licenças (Vercel/Supabase do Licenciante)** — chave de licença,
  status de ativação e datas de validade;
- **GitHub** — verificação de versão e download de atualizações;
- **Provedores escolhidos pelo streamer** (Twitch, TikTok, YouTube, LivePix,
  Mercado Pago) — quando o próprio streamer configura a integração;
- **Autoridades** — mediante obrigação legal, ordem judicial ou requisição
  administrativa válida.

---

## 8. Retenção

8.1. **Dados locais:** permanecem no computador até o usuário limpar as
configurações, desinstalar o aplicativo ou removê-los manualmente.

8.2. **Licença:** mantida enquanto a licença estiver ativa e por até 5 anos após
o encerramento, para fins de auditoria, prevenção a fraude e cumprimento de
obrigações legais.

8.3. **Fila e histórico:** retidos no Supabase do streamer conforme a política
dele. O app não possui rotina automática de expurgo.

---

## 9. Segurança

9.1. Medidas adotadas:

- criptografia de segredos via `safeStorage` (quando disponível);
- `contextIsolation: true` e `nodeIntegration: false` no renderer;
- validação de licença por endpoint HTTPS com credenciais administrativas
  mantidas apenas no servidor;
- HTTPS em todas as chamadas de rede;
- nenhuma chave privada ou secret embutido no executável.

9.2. Nenhum sistema é 100% seguro. O usuário deve manter o sistema operacional
atualizado, usar senha no dispositivo e não compartilhar tokens, secrets ou a
chave de licença.

9.3. A equipe técnica da Tenebris (Licenciante) possui acesso administrativo
controlado ao banco de dados centralizado (filas, histórico e configurações
operacionais), estritamente para suporte técnico, manutenção de infraestrutura,
auditoria de segurança e prevenção a fraudes. Esse acesso está sujeito a
rigoroso dever de confidencialidade e não envolve uso ou compartilhamento
comercial dos dados.

9.4. Em caso de incidente de segurança que possa afetar dados pessoais sob nossa
responsabilidade, comunicaremos os titulares e a ANPD conforme a LGPD.

---

## 10. Direitos do titular (LGPD)

O titular pode solicitar, nos termos dos arts. 18 e seguintes da LGPD:

- confirmação da existência de tratamento;
- acesso aos dados;
- correção de dados incompletos ou desatualizados;
- anonimização, bloqueio ou eliminação de dados desnecessários;
- portabilidade, quando aplicável;
- informação sobre compartilhamentos;
- revogação do consentimento, quando essa for a base legal.

10.1. Para dados de fila/chat/histórico, o contato deve ser feito **diretamente
ao streamer**, que é o controlador desses dados.

10.2. Para dados de licença, o contato é com a Tenebris pelos canais
oficiais de suporte informados na compra. Responderemos em até 15 dias, prorrogáveis
quando houver justificativa.

---

## 11. Crianças e adolescentes

O aplicativo é destinado a maiores de 18 anos ou a menores devidamente
assistidos por responsável legal. Não coletamos intencionalmente dados de
crianças. Se identificarmos tratamento indevido, os dados serão eliminados.

---

## 12. Transferência internacional

12.1. O serviço de licenças (Vercel e Supabase do Licenciante) e o GitHub podem
processar dados em servidores fora do Brasil. Nesses casos, adotamos medidas
contratuais e técnicas compatíveis com os arts. 33 a 36 da LGPD.

12.2. O streamer é responsável por verificar a região do seu próprio projeto
Supabase.

---

## 13. Alterações desta Política

13.1. Esta Política pode ser atualizada para refletir mudanças no aplicativo ou
na legislação.

13.2. A versão vigente acompanha o aplicativo (arquivo `PRIVACY.md` na pasta de
recursos) e os canais oficiais. Alterações relevantes serão comunicadas com
antecedência razoável.

---

## 14. Contato

**Tenebris** — canais oficiais de suporte informados na compra.
Assunto: Privacidade / LGPD — ChessStream Hub.

---

### Anexo — Onde ficam os arquivos no Windows

| Caminho | Conteúdo |
| --- | --- |
| `%APPDATA%\chessstream-hub\config.json` | Configurações e segredos cifrados (`electron-store`) |
| `%APPDATA%\ChessStream Hub\logs` | Logs locais do aplicativo (se gerados) |
| `%LOCALAPPDATA%\Programs\chessstream-hub` | Instalação padrão (NSIS, por usuário) |

Para apagar os dados locais, desinstale o aplicativo e remova manualmente a pasta
`%APPDATA%\chessstream-hub`.
