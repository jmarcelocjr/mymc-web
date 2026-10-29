# Plano: visualizador/gerenciador de saves de memory card PS2 em TypeScript

## Objetivo

Construir uma aplicação web em TypeScript que, ao selecionar um arquivo de memory card do PCSX2 (`.ps2`), mostre os saves contidos nele numa tela inspirada no navegador de memory card da BIOS do PS2 (grade de ícones 3D animados) e permita gerenciá-los (exportar, importar, apagar), tudo no browser, sem backend.

É um projeto independente. Integração com RomM/sync **não faz parte deste projeto**.

A lógica de leitura e escrita fica em `src/core/`, **sem dependência de DOM**, para manter a UI fina e o core testável (e extraível para um pacote no futuro, se precisar).

## Decisões tomadas (sessão de revisão, 2026-10-29)

1. App web standalone, um único projeto Vite; `src/core/` sem DOM (garantido por regra de lint). Sem sync com RomM.
2. Escrita por **reconstrução**: toda operação de escrita gera um card novo formatado a partir da lista de saves, nunca edição in-place da FAT.
3. Após cada reconstrução, o card novo é reaberto pelo próprio leitor e comparado com o esperado; se divergir, o download não é oferecido.
4. Saves ilegíveis no card de origem: aviso listando quais e por quê; o usuário confirma continuar sem eles ou o card fica somente leitura na sessão.
5. Importação: `.psu` e `.max`. Exportação: `.psu` e `.zip`.
6. Todos os tamanhos de card de arquivo (8, 16, 32, 64 MB); a saída tem o mesmo tamanho e parâmetros da entrada. Botão "novo card vazio" com seletor de tamanho (padrão 8 MB). Folder memory cards fora do escopo.
7. Fixtures sintéticas geradas por script e commitadas (repo público); o card real do usuário só é usado localmente.
8. Stack de UI: React + Vite + Three.js, deploy no GitHub Pages.
9. Tela principal no estilo da BIOS, com ícones 3D cedo no plano (fase 2 estáticos, fase 3 animados).

## Princípios (obrigatórios)

1. **Nunca alterar o arquivo original.** Toda escrita gera uma imagem nova em memória, oferecida como download.
2. **Leitura antes de escrita.** A escrita (fase 5) só começa com a leitura validada contra a ferramenta de referência.
3. **Nunca perder dados silenciosamente.** A reconstrução copia **tudo** que está na raiz (saves de PS2, PS1, PocketStation, entradas ocultas, arquivos soltos), preservando por entrada: `mode`, `attr`, datas de criação/modificação, nome e ordem dos arquivos. O que não puder ser lido é reportado (ver decisão 4), nunca omitido em silêncio.
4. **Robustez contra arquivos malformados.** Checagem de limites em toda leitura, detecção de ciclos em cadeias da FAT, limite de profundidade de diretórios. Um card ou ícone corrompido gera erro claro, nunca loop infinito ou crash. Um `.ico` que falhe no parse vira um placeholder 2D, sem quebrar a grade.
5. **Os offsets deste documento são ponto de partida, não verdade absoluta.** Antes de implementar cada estrutura, confirmar no código-fonte de referência (ver "Referências"). Se houver divergência, o código de referência vence; registrar a correção neste arquivo.
6. **Core sem dependências de runtime.** Usar `DataView`/`Uint8Array` (little-endian) e `TextDecoder('shift_jis')` para títulos.

## Stack

- TypeScript estrito (`strict: true`), Vite, React.
- Um único projeto:
  - `src/core/`: leitura, escrita/reconstrução, ECC, formatos `.psu`/`.max`, parser de `icon.sys` e `.ico`. Sem DOM, sem dependências.
  - `src/ui/`: React, renderização 3D com Three.js.
- Dependências de UI permitidas: `react`, `three`, `fflate` (zip). Nada mais sem motivo.
- Testes com Vitest. Fixtures geradas por script (ver "Validação").
- Deploy automático no GitHub Pages a cada push na branch principal.

## Formato do arquivo (resumo para orientar a implementação)

> Confirmar tudo em `ps2mc.py`, `ps2mc_dir.py` e `ps2mc_ecc.py` do mymc antes de codar.

### Páginas, clusters e ECC

- Página: 512 bytes de dados. Cluster: 2 páginas (1024 bytes). Erase block: 16 páginas.
- Imagens com ECC: cada página bruta tem 528 bytes (512 dados + 16 spare). O spare guarda 3 bytes de ECC para cada bloco de 128 bytes (12 bytes) mais 4 de preenchimento.
- Tamanhos suportados (com ECC): 8 MB = 8192 clusters × 2 × 528 = **8.650.752 bytes** (`Mcd001.ps2` padrão do PCSX2); 16, 32 e 64 MB escalam o número de clusters. **Nada pode assumir 8192 clusters.**
- Detectar o layout pelo tamanho: múltiplo de 528 por página → com ECC; múltiplo de 512 → sem ECC. O tamanho deve bater com `clusters_per_card` do superbloco; senão, erro claro.
- Na leitura, o ECC pode ser ignorado (opcionalmente validado e reportado). Na escrita, o ECC é calculado para todas as páginas.

### Superbloco (página 0)

| Offset | Tipo | Campo | Valor típico (8 MB) |
|---|---|---|---|
| 0x00 | char[28] | magic | `Sony PS2 Memory Card Format ` |
| 0x1C | char[12] | versão | `1.2.0.0` |
| 0x28 | u16 | page_len | 512 |
| 0x2A | u16 | pages_per_cluster | 2 |
| 0x2C | u16 | pages_per_erase_block | 16 |
| 0x30 | u32 | clusters_per_card | 8192 |
| 0x34 | u32 | alloc_offset | 41 |
| 0x38 | u32 | alloc_end | 8135 |
| 0x3C | u32 | rootdir_cluster | 0 (relativo a alloc_offset) |
| 0x40 | u32 | backup_block1 | 1023 |
| 0x44 | u32 | backup_block2 | 1022 |
| 0x50 | u32[32] | ifc_list (clusters da FAT indireta) | |
| 0xD0 | u32[32] | bad_block_list | |
| 0x150 | u8 | card_type | 2 |
| 0x151 | u8 | card_flags | |

Validar magic e parâmetros; rejeitar com mensagem clara se não bater. Na reconstrução, reutilizar os parâmetros do card de origem (tamanho, `card_flags` etc.); para "novo card vazio", usar os valores que o mymc gera para o tamanho escolhido.

### FAT (dupla indireção)

- Cada cluster de FAT contém 256 entradas u32.
- Para a entrada `n`:
  - `fat_offset = n % 256`
  - `indirect_index = floor(n / 256)`
  - `indirect_offset = indirect_index % 256`
  - `dbl_indirect_index = floor(indirect_index / 256)`
  - `indirect_cluster = ifc_list[dbl_indirect_index]`
  - `fat_cluster = cluster(indirect_cluster)[indirect_offset]`
  - `entry = cluster(fat_cluster)[fat_offset]`
- Os clusters da FAT e da FAT indireta usam números **absolutos**; os clusters de dados nas cadeias são **relativos a `alloc_offset`** (confirmar).
- Entrada: bit 31 (`0x80000000`) = alocado; bits 0–30 = próximo cluster. `0xFFFFFFFF` = fim de cadeia. `0x7FFFFFFF` = livre.
- Espaço livre = número de entradas livres entre `0` e `alloc_end - 1`, × 1024 bytes.

### Entradas de diretório (512 bytes, 2 por cluster)

| Offset | Tipo | Campo |
|---|---|---|
| 0x00 | u16 | mode (flags) |
| 0x04 | u32 | length (bytes se arquivo; nº de entradas se diretório) |
| 0x08 | tod[8] | criado |
| 0x10 | u32 | cluster inicial (relativo) |
| 0x14 | u32 | dir_entry (índice no diretório pai) |
| 0x18 | tod[8] | modificado |
| 0x20 | u32 | attr |
| 0x40 | char[32] | nome (terminado em NUL) |

Flags de `mode` (confirmar no mymc): `0x0001` read, `0x0002` write, `0x0004` execute, `0x0008` protected, `0x0010` file, `0x0020` directory, `0x0400` (bit sempre presente em saves de PS2), `0x0800` PocketStation, `0x1000` save de PS1, `0x2000` hidden, `0x8000` existe.

- Formato `tod` (8 bytes): `[0] não usado, [1] seg, [2] min, [3] hora, [4] dia, [5] mês, [6..7] ano u16`. O horário de cards reais é JST (UTC+9); expor como está e documentar.
- O diretório raiz começa em `rootdir_cluster` e suas duas primeiras entradas são `.` e `..`. Subdiretórios também começam com `.` e `..`, que contam no `length`.
- Entradas sem a flag `0x8000` estão apagadas e devem ser ignoradas na listagem.
- Cada save de PS2 é um diretório na raiz (ex.: `BASLUS-21005...`) contendo `icon.sys`, os ícones `.ico` e os arquivos de dados.

### `icon.sys` (964 bytes)

| Offset | Campo |
|---|---|
| 0x00 | magic `PS2D` |
| 0x06 | u16: posição (em bytes) da quebra de linha no título |
| 0x0C | transparência do fundo |
| 0x10 | cores de fundo (4 cantos × RGBA u32) |
| 0x50 | direções de luz (3 × float32[4]) |
| 0x80 | cores de luz (3 × float32[4]) |
| 0xB0 | luz ambiente (float32[4]) |
| 0xC0 | título, 68 bytes Shift-JIS |
| 0x104 | nome do ícone "normal" (64 bytes) |
| 0x144 | nome do ícone "copiar" (64 bytes) |
| 0x184 | nome do ícone "apagar" (64 bytes) |

- Decodificar o título com `TextDecoder('shift_jis')`. Muitos jogos usam ASCII full-width; normalizar para exibição (NFKC) mantendo o original disponível.
- Dividir o título em duas linhas usando o offset em 0x06.
- Os três nomes de ícone podem apontar para o mesmo arquivo; quando diferentes, a UI usa cada um no estado correspondente.
- Saves de PS1 armazenados no card não têm `icon.sys`; exibir pelo nome do diretório com placeholder.

### `.ico` (modelo 3D animado)

> Confirmar no ps2mc-browser e na documentação de ícones do PS2 antes de codar; o layout abaixo é aproximado.

- Cabeçalho: magic/versão (`0x00010000`), nº de formas de animação (shapes), tipo de textura (indica se está comprimida), um float de escala, nº de vértices.
- Por vértice: uma posição (s16 x, y, z, w) **por shape**, normal (s16 × 4), UV (s16 × 2), cor RGBA (u8 × 4). Coordenadas em ponto fixo (dividir por 4096; confirmar).
- Seção de animação: cabeçalho (velocidade, offset de início, nº de frames) e, por frame, keyframes (tempo, peso) que interpolam entre as shapes (morph targets).
- Textura 128×128 em RGB5A1 (32.768 bytes), ou comprimida (RLE de u16) conforme o tipo de textura.
- Renderização: morph targets do Three.js; luzes e gradiente de fundo vindos do `icon.sys`.

### Formatos de save

- `.psu` (uLaunchELF/EMS): sequência de cabeçalhos de 512 bytes no formato de entrada de diretório, seguidos dos dados de cada arquivo alinhados a 1024 bytes. Confirmar em `ps2save.py`.
- `.max` (Action Replay Max): cabeçalho com magic `Ps2PowerSave`, checksum, nome do diretório, nome do `icon.sys`, tamanho comprimido e nº de arquivos, seguido do conteúdo comprimido com LZARI. Portar `lzari.py` (só descompressão). Confirmar em `ps2save.py`.
- `.cbs`, `.xps`, `.sps`: fora do escopo por enquanto.

## API do core (proposta)

```ts
interface MemoryCard {
  superblock: Superblock;
  hasEcc: boolean;
  freeBytes(): number;
  listSaves(): SaveSummary[];               // todas as entradas da raiz
  readDir(path: string): DirEntry[];
  readFile(path: string): Uint8Array;
  problems(): ReadProblem[];                // saves/arquivos que não puderam ser lidos e por quê
}

interface SaveSummary {
  dirName: string;
  title?: { line1: string; line2: string; raw: Uint8Array };
  icons?: { normal: string; copy: string; delete: string };
  sizeBytes: number;                        // soma dos arquivos
  created: Tod; modified: Tod;
  kind: 'ps2' | 'ps1' | 'pocketstation' | 'unknown';
  protected: boolean;
  readable: boolean;
}

// Um save completo em memória: entrada do diretório + arquivos com metadados preservados
interface SaveArchive { dir: DirEntry; files: { entry: DirEntry; data: Uint8Array }[] }

function openCard(bytes: Uint8Array): MemoryCard;          // detecta ECC e tamanho, valida superbloco
function extractAll(card: MemoryCard): SaveArchive[];      // só os saves legíveis
function buildCard(params: CardParams, saves: SaveArchive[]): Uint8Array;  // formata e grava, ECC incluso
function verifyCard(bytes: Uint8Array, expected: SaveArchive[]): VerifyResult;
function blankCard(sizeMb: 8 | 16 | 32 | 64): Uint8Array;

function exportPsu(save: SaveArchive): Uint8Array;
function importPsu(bytes: Uint8Array): SaveArchive;
function importMax(bytes: Uint8Array): SaveArchive;

function parseIconSys(bytes: Uint8Array): IconSys;
function parseIco(bytes: Uint8Array): IconModel;           // shapes, animação, textura RGBA
```

Apagar, importar e substituir são operações sobre a lista de `SaveArchive`, seguidas de `buildCard` + `verifyCard`.

## Interface (referência: tela de memory card da BIOS do PS2)

Referência visual: `the-playstation-2-memory-card-screen-v0-vcadiab4szf11.webp` neste diretório. Não precisa ser idêntica, mas deve ter o mesmo espírito:

- Fundo em gradiente; ao selecionar um save, usar as cores de fundo do `icon.sys` dele.
- Canto superior esquerdo: "Memory Card (PS2)" e espaço livre.
- Canto superior direito: título do save selecionado em duas linhas.
- Grade de ícones 3D; o selecionado fica destacado (brilho/rotação).
- Rodapé com dicas de ações (abrir, voltar, opções), clicáveis e com atalhos de teclado.
- Todos os ícones num **único canvas WebGL** compartilhado (browsers limitam o número de contextos WebGL).
- Ao apagar ou copiar/exportar, usar o ícone e a animação de "apagar"/"copiar" do save.
- Painel de detalhe: arquivos internos com tamanhos e datas, dump hexadecimal opcional.
- Ações de card: abrir arquivo (drag-and-drop ou input, nada é enviado para servidor), novo card vazio, baixar card modificado.

## Fases

### Fase 0: estrutura
- Vite + React + TS estrito, Vitest, lint (com regra impedindo DOM/React em `src/core/`).
- `scripts/make-fixtures.sh` gerando as fixtures (ver "Validação"), commitadas em `test/fixtures/`.
- Workflow de deploy no GitHub Pages.
- **Pronto quando:** `npm test` roda (vazio), o build sobe uma página em branco e o deploy publica.

### Fase 1: leitura (core)
- Detecção de ECC e tamanho, leitura de páginas e clusters removendo o spare.
- Superbloco com validação, para todos os tamanhos.
- FAT com dupla indireção; seguir cadeias com detecção de ciclo e limite de tamanho.
- Diretórios recursivos, leitura de arquivos respeitando `length`.
- Parser de `icon.sys`. `listSaves()`, `freeBytes()`, `problems()`.
- (Opcional) validação de ECC por página, reportando páginas inválidas sem abortar.
- **Pronto quando:** para cada fixture, a listagem (nomes, tamanhos, datas) e o espaço livre batem com a saída de `mymc dir`/`df`, e cada arquivo extraído é idêntico byte a byte ao exportado pela ferramenta de referência.

### Fase 2: tela estilo BIOS com ícones estáticos
- Parser de `.ico` (geometria, normais, UV, textura, incluindo textura comprimida).
- Grade 3D num único canvas, cada ícone no primeiro frame, com textura e luzes do `icon.sys`.
- Cabeçalho (card, espaço livre, título do selecionado), seleção por mouse e teclado, fundo com as cores do save.
- Placeholder para saves sem ícone ou com `.ico` inválido.
- Painel de detalhe, busca/ordenação, mensagens de erro claras para arquivo inválido.
- **Pronto quando:** abrir o `Mcd001.ps2` real mostra os mesmos saves que o browser da BIOS no PCSX2, com ícones reconhecíveis.

### Fase 3: animação e estados
- Animação idle (morph entre shapes conforme os keyframes).
- Destaque do selecionado.
- Ícones e animações de "copiar" e "apagar" tocados nas ações correspondentes (com stubs até as fases 4 e 5).
- **Pronto quando:** os ícones animam de forma parecida com o PCSX2 e saves com ícones distintos trocam de ícone por estado.

### Fase 4: exportação
- Exportar um save como `.psu`.
- Exportar os arquivos brutos de um save como `.zip` (`fflate`).
- **Pronto quando:** um `.psu` exportado é importado pelo mymc++ sem erro e o conteúdo é idêntico.

### Fase 5: escrita por reconstrução
- Port do ECC (`ps2mc_ecc.py`), testado contra páginas das fixtures.
- `buildCard`: formatar card com os parâmetros da origem e gravar todos os saves em sequência, preservando metadados (princípio 3).
- `verifyCard` após toda reconstrução; download só se passar.
- Saves ilegíveis: aviso e confirmação, ou card somente leitura (decisão 4).
- Apagar save; importar `.psu` e `.max` (porte da descompressão LZARI); checar espaço. Nome de diretório duplicado: perguntar se substitui, mostrando as datas de modificação dos dois.
- Saves importados mantêm datas e flags originais do arquivo.
- Novo card vazio (8/16/32/64 MB).
- **Pronto quando:** reconstruir uma fixture sem alterações gera um card que o `check` do mymc++ aceita e cuja listagem e conteúdo batem com a origem; cada operação gera um card aceito pelo `check` e que o PCSX2 abre normalmente.

### Fase 6 (opcional): merge de cards
- `diffCards(a, b)`: por diretório, indicar só em A, só em B, iguais (hash do conteúdo) ou divergentes (com as datas de cada lado).
- `mergeCards`: reconstrução com a versão escolhida de cada save; padrão = mais recente, com conflitos expostos. Atenção a jogos que usam mais de um diretório.
- UI: dois cards lado a lado.

### Fora do escopo por enquanto
- Sync com RomM.
- Formatos `.cbs`, `.xps`, `.sps`.
- Folder memory cards do PCSX2.
- Cards de PS1 (`.mcr`).

## Validação

- Ferramenta de referência: `mymc++` (`pip install mymcplusplus`).
- **Antes da fase 0**, confirmar se o mymc++ permite formatar cards de 16/32/64 MB e sem ECC. Se não permitir, gerar essas fixtures de outra forma (ex.: PCSX2 para os tamanhos maiores) e registrar aqui.
- O repositório é **público**: nenhum save real de jogo vai para o repo.
- `scripts/make-fixtures.sh` gera, com saves sintéticos (diretório com `icon.sys` feito à mão, incluindo título Shift-JIS, `.ico` simples válido e dados aleatórios):
  1. Card vazio formatado.
  2. Card com 1 save.
  3. Card com vários saves, incluindo um apagado (entradas sem a flag de existência e clusters liberados).
  4. Card fragmentado (saves adicionados e apagados intercalados).
  5. Card cheio.
  6. Diretório com flags de PS1.
  7. Cards de 16, 32 e 64 MB.
  8. Imagem sem ECC, se a ferramenta permitir.
  9. `.psu` e `.max` de um save sintético (para testar a importação).
- Para cada fixture, salvar como "golden files" a saída de `dir`/`df` e os arquivos exportados, e comparar nos testes.
- Card real: carregado por variável de ambiente (`PS2_REAL_CARD=/caminho/Mcd001.ps2`); os testes que dependem dele são pulados se a variável não existir. Nunca commitado.
- Testes negativos: magic inválido, tamanho inválido, tamanho que não bate com o superbloco, cadeia de FAT cíclica, cluster fora dos limites, diretório com `length` absurdo, `.ico` truncado, `.max` corrompido.

## Correções e descobertas

Registradas conforme o princípio 5 (a referência vence o plano).

- **Fase 0 (2026-10-29), mymc++ 3.2.0:**
  - O `format` aceita `-c <clusters>` (8192/16384/32768/65536 = 8/16/32/64 MB) e `-e` (sem ECC). Todas as fixtures saem da mesma ferramenta.
  - O mymc++ detecta ECC tentando ler a página 0 com verificação de ECC, não pelo tamanho. O nosso leitor usa o tamanho (mais simples e determinístico), mas deve conferir com o superbloco.
  - Superbloco gravado pelo mymc++: u16 `0xFF00` em 0x2E, `card_type` = 2 e `card_flags` = `0x2B`.
  - O limite de clusters alocáveis é `min(backup_block1, backup_block2) × pages_per_erase_block / pages_per_cluster − alloc_offset`; o espaço livre conta as entradas livres de `0` a `alloc_end − 1`.
  - Entrada de diretório: o campo de nome no struct do mymc++ tem 448 bytes (0x40 até o fim); usar até o primeiro NUL, limitado a 32.
  - Frames de animação do `.ico`: o mymc++ lê `key_count − 1` keys. As fixtures foram geradas assim; **confirmar na fase 2** contra o ps2mc-browser.
  - Bug do mymc++: o `dir` quebra em cards com save de PS1. Nesses casos o `mymc_dir` do golden fica `null`; o JSON estruturado continua valendo.
- **Fase 1 (2026-10-29):**
  - **Detecção de ECC pelo tamanho é ambígua sozinha:** 8.650.752 (8 MB com ECC) também é múltiplo de 512. O leitor compara o tamanho com `clusters_per_card × 2 × 528` (com ECC) ou `× 512` (sem ECC); qualquer outro tamanho é recusado.
  - Diretório raiz: o mymc++ sempre usa o cluster relativo 0; o leitor usa `rootdir_cluster` do superbloco (0 em todos os cards conhecidos) e lê o `length` da raiz na entrada `.`.
  - Arquivo vazio tem cluster inicial `0xFFFFFFFF` e nenhuma cadeia.
  - Proteção tem quatro estados, derivados de `mode & (0x0008 | 0x0002)`: `0` = protegido contra apagar, só write = sem proteção, só protected = protegido contra cópia e apagar, ambos = protegido contra cópia. A API expõe `protection: 'none' | 'copy' | 'delete' | 'copy-and-delete'` em vez de um booleano.
  - Tamanho do save como o PS2 mostra (`dir_size` do mymc): entradas do diretório arredondadas para clusters, mais cada arquivo arredondado para clusters. É o `sizeOnCard`.
  - Saves de PS1 têm título: o arquivo com o mesmo nome do diretório começa com um cabeçalho de 128 bytes (magic `SC`, título Shift-JIS de 64 bytes no offset 4). O mymc++ tem um bug nessa leitura (compara `str` com `bytes`) e o `dir` quebra; o nosso leitor implementa.
  - Datas: o mymc++ grava em horário do Japão (UTC+9), confirmado nas fixtures.
  - Validação de ECC: páginas apagadas (dados e spare todos `0xFF`) não são verificadas. O relatório separa `failed` (todas as páginas com ECC errado) de `failedInUse` (só página 0, FAT indireta, FAT e clusters de dados alocados).
  - **Card real (`Mcd001.ps2` do PCSX2):** a página 1 (segunda página do cluster do superbloco, fora do sistema de arquivos) tem 8 bytes de dados (`51a23f21 65151612`) e o resto `0xFF`, mas o ECC gravado é o de uma página toda em branco. Quem escreveu esses bytes não atualizou o ECC; origem desconhecida (BIOS ou PCSX2). Não afeta nenhum save, e o mymc++ nunca lê essa página. **Para a fase 5:** a reconstrução deve copiar a página 1 da origem como está (dados e spare), para não perder esses bytes.
  - API implementada (difere um pouco da proposta): `openCard`, `MemoryCard.{superblock, layout, hasEcc, freeBytes, readDir, stat, readFile, listSaves, problems, checkEcc, clusterChain}`; `SaveSummary.{name, entry, kind, title{lines, display, raw}, iconSys, sizeOnCard, protection, hidden, readable, problem}`. `kind` inclui `'file'` para arquivos soltos na raiz. Cada `DirEntry` guarda os 512 bytes brutos para a reconstrução preservar campos não interpretados.
- **Fase 2 (2026-10-29):**
  - `.ico`: a contagem de keys gravada em cada frame é `keys + 1`. O mymc++ e o ps2mc-browser concordam, e as fixtures seguem isso. Textura em A1B5G5R5 (vermelho nos 5 bits baixos); RLE como no plano.
  - Ícones sem textura (bit 2 do tipo desligado, ex.: Sly Cooper) usam a cor por vértice (0–255). Com textura, a cor por vértice fica em 0x80 e é ignorada.
  - Iluminação (igual ao ps2mc-browser): `(ambiente + Σ max(dot(n, −dir), 0) × cor) × textura`. Se o `icon.sys` tiver todas as luzes zeradas, usamos uma iluminação padrão para o ícone não ficar preto.
  - Coordenadas do ícone têm −y para cima; a conversão para o Three.js é `(x, −y, −z)` (rotação de 180° em x, sem espelhar).
  - Fundo: cantos do `icon.sys` na ordem superior-esquerdo, superior-direito, inferior-esquerdo, inferior-direito, valores 0–255, misturados sobre o cinza neutro com alfa `transparência / 128` (como o ps2mc-browser).
  - Animação, para a fase 3: o ps2mc-browser não usa os keyframes. Ele interpola a forma i para i+1 em loop, com `frame = t × 60 × velocidade mod frame_length`. Os keyframes ficam disponíveis no parser caso a fase 3 precise.
  - Datas na UI: convertidas do horário do Japão para o fuso local do navegador.
  - Grade: 5 colunas (4 ou 3 em telas estreitas). As linhas cabem entre o cabeçalho e o rodapé, medidos na hora, e os ícones que saem dessa faixa somem com fade.
  - Tamanho dos ícones: cada jogo modela o ícone numa escala diferente (o do Sly é bem maior que o do Harry Potter). Todo ícone é normalizado para a mesma altura/largura máxima e centralizado na mesma altura da célula. Os limites vêm da geometria (`boundingBox`), não de `Box3.setFromObject`: ao reordenar, o objeto reaproveitado ainda carrega escala e posição do layout anterior, o que deslocava os ícones para fora das células.
  - O brilho atrás do ícone selecionado fica na linha câmera → centro do ícone, senão a perspectiva o desloca para o lado nas colunas das pontas.
- **Fase 3 (2026-10-29):**
  - Semântica dos keyframes (deduzida do ícone real do Harry Potter, 4 shapes): cada frame da animação dá, para uma shape, chaves (tempo, peso). Lidos como degraus (a shape mantém o peso da última chave até a próxima, dando a volta no loop), os pesos somam 1 em todo instante. Interpolando linearmente os vetores de peso de um tempo de chave ao próximo sai o loop pretendido (0 → 1 → 2 → 3 → 2 → 0, com as chaves de 0,5 como meio-termo). Interpolar cada shape isoladamente entre as próprias chaves não soma 1 e deforma o ícone. Sem chaves usáveis, cai no loop do ps2mc-browser (shape i → i+1). Implementado em `src/core/iconAnim.ts` (`ShapeBlender`, `animationFrame`, 60 quadros/s × velocidade + play offset).
  - O morph roda na CPU (soma ponderada de todas as shapes, só quando os pesos mudam), porque o peso pode cair em mais de duas shapes ao mesmo tempo; o shader ficou só com a iluminação.
  - Todos os ícones visíveis tocam a animação idle; o selecionado gira em torno do eixo vertical (~6 s por volta) e os outros voltam a ficar de frente. `prefers-reduced-motion` desliga giro e idle.
  - Copiar/apagar: `GridApi.playAction(nome, 'copy' | 'delete', restore)` troca para o ícone do estado (de `icon.sys`), toca a animação dele do primeiro quadro e resolve a Promise no fim. Copiar: pulo com uma volta. Apagar: sobe, gira mais rápido e encolhe até sumir; com `restore = false` o ícone fica escondido até a lista mudar (para a fase 5). Até as fases 4 e 5, o painel de detalhes tem "Preview" para os dois estados.
- **Fixtures:** guardadas como `.ps2.gz` (gzip com mtime 0), mais um `.json` por card com o que o mymc++ vê: superbloco, espaço livre, árvore com `mode`, datas, `attr`, cluster inicial, cadeia de clusters (em faixas) e sha256 de cada arquivo. Total de cerca de 1,2 MB. O `*.ps2` está no `.gitignore` para nenhum card real ser commitado por engano.

## Referências

- mymc (Ross Ridge), fonte principal da especificação: https://github.com/ps2dev/mymc
  - `ps2mc.py` (superbloco, FAT, alocação), `ps2mc_dir.py` (entradas de diretório e `tod`), `ps2mc_ecc.py` (ECC), `ps2save.py` (formatos `.psu`, `.max` etc.), `lzari.py`
- mymc++ (Python 3, mantido): https://github.com/Adubbz/mymcplusplus
- Documentação de memory cards do PCSX2: https://pcsx2.net/docs/configuration/memcards
- ps2mc-browser (ícones 3D, parser de `.ico`): projeto de caol64 no GitHub
- Referência visual da UI: `the-playstation-2-memory-card-screen-v0-vcadiab4szf11.webp` (neste diretório)

## Instruções para o Claude Code

- Trabalhar fase a fase; ao final de cada fase, rodar os testes e parar para revisão antes da próxima.
- Antes de implementar cada estrutura do formato, ler o trecho correspondente da referência e corrigir este plano se algum offset ou regra divergir.
- Não introduzir dependências de runtime em `src/core/`.
- Não implementar nada de escrita (fase 5) antes de a fase 1 passar em todas as fixtures.
