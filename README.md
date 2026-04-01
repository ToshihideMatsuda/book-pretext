# book-pretext

書籍を読むためのVite + TypeScript 製のシンプルなビューワです。`@chenglou/pretext` を使って本文レイアウトを行い、ページ送り、検索、目次、タップ / スワイプ操作を提供します。

この公開版には、青空文庫由来のうち公開上扱いやすい作品のみを同梱しています。

## Files

- `index.html`: 画面全体のシェルとスタイル
- `src/main.ts`: ビューワ本体のロジック
- `books/`: 表示対象のテキスト

## Included Texts

- 夏目漱石: 『坊っちゃん』『こゝろ』『吾輩は猫である』
- 芥川龍之介: 『羅生門』『鼻』

## License

このリポジトリのコードは [MIT License](./LICENSE) です。

`books/` 以下のテキストは MIT License の対象外です。各テキストの出典表記と、青空文庫の取り扱い規準に従ってください。

## Source Attribution

- 収録テキストの出典: [青空文庫](https://www.aozora.gr.jp/)
- 各テキストファイル末尾の出典表記もあわせて参照してください。
- 公開版では配布上の整理のため、一部作品は同梱していません。

## Development

```sh
npm install
npm run dev
```

## Build

```sh
npm run build
```

## Preview

```sh
npm run preview
```
