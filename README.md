# Sound-Asaph

Aplicativo leve de cifras para navegador, feito com HTML, CSS e JavaScript. As dependências Node são usadas apenas para ler documentos Word/PDF durante a sincronização do Drive. Inclui catálogo pesquisável, transposição por semitom, capotraste, modo palco persistente por navegador, ajuste de fonte, rolagem automática e uma página inicial em roxo escuro.

## Requisitos

- Node.js 18 ou superior
- Navegador moderno

## Executar localmente

Na pasta do projeto, rode:

```bash
npm install
npm start
```

Abra [http://localhost:4173](http://localhost:4173). O servidor é necessário para carregar o catálogo JSON; abrir o `index.html` diretamente não funciona de forma confiável.

No PowerShell do Windows, se a política do sistema bloquear `npm.ps1`, use `npm.cmd start` no lugar.

## Instalar no celular, tablet ou computador

O Sound-Asaph pode ser instalado como aplicativo web (PWA) pelo navegador. Publique os arquivos `manifest.webmanifest`, `service-worker.js` e a pasta `icons` junto com os arquivos do app. O site precisa ser acessado por HTTPS; o endereço `localhost` também funciona para desenvolvimento.

- **Android:** abra o site no Chrome, toque em **Instalar aplicativo** dentro do catálogo ou escolha **Instalar app/Adicionar à tela inicial** no menu do Chrome.
- **iPhone/iPad:** abra o site no Safari, toque em **Compartilhar → Adicionar à Tela de Início → Adicionar**. O botão do app mostra essas instruções; o Safari não oferece o diálogo de instalação programático usado por outros navegadores.
- **Computador:** no Chrome ou Edge, use **Instalar aplicativo** no catálogo, o ícone de instalação na barra de endereço ou **Instalar Sound-Asaph** no menu do navegador.

O app guarda em cache a interface e os catálogos incluídos no projeto para abrir sem rede depois da primeira visita. A instalação não baixa automaticamente músicas e áudios do Google Drive; sincronize com a internet para carregá-los. Alterações em códigos-fonte não atualizam cópias já instaladas até o navegador visitar a versão publicada novamente.

## Sincronizar uma pasta compartilhada do Google Drive

O Admin pode conectar uma pasta do Google Drive ou de um Shared Drive. A sincronização lê também as subpastas e importa `.txt`, `.md`, `.pdf`, `.doc`, `.docx` e Google Docs. No GitHub Pages, PDF/Word ainda exigem uma API de extração publicada; localmente, a extração usa o servidor Node do app. Arquivos de áudio comuns (MP3, MP4, MPEG, OGG, WAV e M4A) podem ser reproduzidos do Drive, com limite de 100 MB por arquivo para download no navegador. Importações feitas no aplicativo são enviadas como `.txt` para a pasta da categoria; edições de arquivos `.txt`/`.md` e exclusões de músicas sincronizadas também são aplicadas ao Drive. Alterações feitas diretamente no Drive aparecem quando o Admin sincroniza novamente. A lista de Louvor de Domingo e as preferências da interface continuam locais a cada navegador.

O OAuth usa `https://www.googleapis.com/auth/drive`, que concede acesso amplo ao Drive da conta conectada e não pode ser limitado tecnicamente à pasta configurada. A conta ainda precisa ter permissão de edição no Shared Drive para gravar ou apagar arquivos. Avalie esse escopo antes de autorizar. O token de acesso não é salvo pelo Sound-Asaph.

1. No [Google Cloud Console](https://console.cloud.google.com/), crie um projeto ou escolha um existente e ative a **Google Drive API**.
2. Configure a tela de consentimento OAuth e adicione sua conta como usuário de teste, caso o app esteja em modo de teste.
3. Crie uma credencial **OAuth client ID** do tipo **Web application**. Em **Authorized JavaScript origins**, adicione `http://localhost:4173` e a origem HTTPS do GitHub Pages onde o app será publicado.
4. Abra `drive-config.js` e preencha o Client ID e o ID da pasta:

   ```js
   window.SOUND_ASAPH_CONFIG = Object.freeze({
     googleClientId: "SEU_CLIENT_ID.apps.googleusercontent.com",
     driveFolderId: "ID_DA_PASTA_NO_DRIVE"
   });
   ```

   O ID da pasta é o trecho final da URL do Drive, depois de `/folders/`. Não coloque um client secret nesse arquivo.
5. Reinicie `npm start`, abra o app como Admin e selecione **Conectar Drive**. Entre na conta que tem acesso à pasta e autorize a leitura e gravação.

Use o ID da pasta raiz compartilhada (o trecho final da URL depois de `/folders/`) em `driveFolderId`. A API é configurada para incluir itens de Shared Drives. Para outro músico acessar o catálogo, ele conecta a própria conta Google que tenha acesso à pasta. As gravações e exclusões só ficam disponíveis no perfil Admin.

A sincronização do Drive é executada pelo navegador. No GitHub Pages, ela pode ler e gravar formatos de texto e exportar Google Docs para leitura; PDF/Word precisam do servidor local para extrair texto e não podem ser editados de volta pelo app. Edições desses formatos e de Google Docs ficam apenas neste navegador, sem alterar o original. Áudios que já estão na pasta do Drive podem ser baixados e reproduzidos pelo app; o envio/gerenciamento de áudios pelo app ainda permanece local. O campo **Louvor de Domingo** é uma lista individual, salva no armazenamento local de cada navegador.

São aceitos documentos Google, `.txt`, `.md`, `.pdf`, `.doc` e `.docx` de até 20 MB. PDFs escaneados sem camada de texto não podem ser lidos (OCR não está incluído). A extração de PDF/Word acontece no servidor local, sem salvar o documento. Linhas de acordes separadas da letra são convertidas em cifras entre colchetes em uma linha própria; arquivos sem acordes reconhecíveis são reportados como não importados. Arquivos em outros formatos são ignorados e contabilizados na mensagem de sincronização. Se o tom não estiver informado no arquivo, o controle de tom mostra `—`; os acordes continuam podendo ser transpostos.

## Importar músicas em lote

1. Coloque arquivos `.txt` ou `.md` na pasta `songs` (crie-a se necessário).
2. Escreva os acordes entre colchetes, como `[G]Grandes são as [D/F#]tuas obras`.
3. Opcionalmente, informe título, artista e tom nas primeiras linhas. Os nomes aceitos são:

   ```text
   Title: Grandes Obras
   Artist: Nome do artista
   Key: G

   [G]Grandes são as [D/F#]tuas obras
   [Em]Tua graça nos [C]alcançou
   ```

   Os metadados também podem ser `Título:`, `Artista:` e `Tom:`. O nome do arquivo é usado como título se ele não for informado. O campo `Key`/`Tom` aceita notas como `G`, `F#` ou `Bb`.
4. Execute `npm run import`. O resultado substitui `data/songs.json`, que o aplicativo já carrega automaticamente.

Também é possível escolher caminhos diferentes:

```bash
node scripts/import-songs.js "C:\caminho\para\minhas-cifras" "data\songs.json"
```

No PowerShell, a forma equivalente é `npm.cmd run import -- "C:\caminho\para\minhas-cifras" "data\songs.json"`.

Arquivos `.doc`/`.docx` não são lidos diretamente; exporte-os ou salve-os como `.txt` ou `.md` antes da importação. A importação valida acordes entre colchetes, letras não vazias e ids duplicados, e informa erros no terminal.

## Catálogo do Drive e fallback local

O diretório de arquivos `musicas/` foi removido após a confirmação de que as cifras e os áudios necessários estão no Drive. Conecte e sincronize o Drive no perfil Admin para carregar o repertório compartilhado; após a sincronização, o catálogo do Drive substitui as cifras embutidas e os áudios do Drive ficam disponíveis para reprodução. Cada dispositivo precisa sincronizar sua própria conta com acesso à pasta compartilhada. O app mantém `data/songs.json` e `data/folder-songs.json` como fallback de cifras quando ainda não há catálogo do Drive salvo neste dispositivo; esses arquivos não incluem os áudios originais.

## Importar pelo aplicativo

Use **Importar músicas** no catálogo para escolher um ou mais arquivos `.txt`, `.md`, `.pdf`, `.doc` ou `.docx` (até 20 MB cada). Os arquivos de texto podem usar acordes junto à letra, como `[G]Grandes são as [D/F#]tuas obras`, ou acordes em linhas separadas. PDF e Word são extraídos pelo servidor local; PDFs escaneados sem texto não são compatíveis. Título, artista e tom podem ser informados nas primeiras linhas usando `Title:`, `Artist:` e `Key:` ou `Título:`, `Artista:` e `Tom:`.

As músicas importadas ficam salvas neste navegador e são acrescentadas ao catálogo do dispositivo, sem apagar as músicas incluídas no projeto. Essa importação não altera os arquivos do projeto nem compartilha as músicas com outros dispositivos. Para incluir cifras no catálogo versionado do projeto, mantenha os arquivos-fonte em `songs` e atualize `data/songs.json` com `npm run import`.

Use o botão de edição ao lado de uma música para alterar título, artista, tom e letra/acordes. As mudanças ficam salvas no navegador atual e permanecem após recarregar o app; alterações locais não são compartilhadas automaticamente com outros dispositivos.

## Perfis de demonstração

O seletor de perfil oferece **Admin**, **Músico** e **Vocal**. A senha pública de demonstração é `123`. O Admin pode importar e remover músicas neste navegador; os três perfis podem editar cifras. O perfil Vocal vê somente a letra e pode reproduzir os áudios vocais disponíveis no Drive após a sincronização ou os áudios adicionados neste navegador. Não há alteração automática de tom dos áudios.

O Admin também vê o painel de áudios vocais da música selecionada e pode adicionar arquivos MP3, MP4, MPEG, OGG, WAV ou M4A (até 100 MB cada), renomear as faixas, substituir seus arquivos ou ocultá-las. Os arquivos adicionados e as alterações de exibição ficam somente neste navegador; essas ações não modificam os arquivos originais do Drive.

Esses perfis são apenas uma demonstração visual: a senha e as permissões estão no código público do site, e as alterações ficam no armazenamento local do navegador. Não há autenticação segura, banco de dados compartilhado ou sincronização de edições entre dispositivos. Para uso real da equipe com permissões e dados compartilhados, é necessário conectar o app a um backend com autenticação.

O app pode ser publicado como site estático no GitHub Pages, mas a extração de PDF/Word feita pelo servidor local não estará disponível nessa hospedagem sem um serviço adicional. Os áudios do Drive são baixados para reprodução e não são armazenados pelo cache offline do aplicativo.

## Usar o aplicativo

- Clique em uma música ou pesquise pelo título no catálogo.
- Use `+` e `−` (ou as teclas correspondentes) para subir/descer um semitom.
- Selecione uma casa de capo. O app mostra o tom desejado e as formas dos acordes para tocar com capo.
- Ative **Modo palco** para usar o tema escuro.
- Use `A+` e `A−` para ajustar a fonte da cifra.
- Pressione `A` para ligar/desligar a rolagem automática. Um toque/gesto na tela a pausa.
- Pressione `/` para focar a busca e `S` para alternar o modo palco.
