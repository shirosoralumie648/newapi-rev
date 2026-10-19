/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import fs from 'node:fs/promises'
import path from 'node:path'

const LOCALES_DIR = path.resolve('src/i18n/locales')

function stableStringify(obj) {
  return JSON.stringify(obj, null, 2) + '\n'
}

const newKeys = {
  en: {
    'Copy cURL': 'Copy cURL',
    'Copy Messages JSON': 'Copy Messages JSON',
    'Copy Node.js': 'Copy Node.js',
    'Copy Python': 'Copy Python',
    cURL: 'cURL',
    '"group" is a Playground-only routing field; the /v1 endpoint uses the API token group instead.':
      '"group" is a Playground-only routing field; the /v1 endpoint uses the API token group instead.',
    'Exports target the OpenAI-compatible /v1/chat/completions endpoint with a placeholder key. Attachments are replaced by file placeholders instead of base64 bytes.':
      'Exports target the OpenAI-compatible /v1/chat/completions endpoint with a placeholder key. Attachments are replaced by file placeholders instead of base64 bytes.',
    'Messages JSON': 'Messages JSON',
    'No request captured': 'No request captured',
    'Node.js': 'Node.js',
    Python: 'Python',
    'Request preview': 'Request preview',
    'Send a message to inspect the exact request payload.':
      'Send a message to inspect the exact request payload.',
    'The exact request built by the last send, ready to copy into your own code.':
      'The exact request built by the last send, ready to copy into your own code.',
    'View the request payload of the last send':
      'View the request payload of the last send',
  },
  zh: {
    'Copy cURL': '复制 cURL',
    'Copy Messages JSON': '复制 Messages JSON',
    'Copy Node.js': '复制 Node.js',
    'Copy Python': '复制 Python',
    cURL: 'cURL',
    '"group" is a Playground-only routing field; the /v1 endpoint uses the API token group instead.':
      '“group” 是 Playground 专用的路由字段；/v1 接口改为从 API 密钥读取分组。',
    'Exports target the OpenAI-compatible /v1/chat/completions endpoint with a placeholder key. Attachments are replaced by file placeholders instead of base64 bytes.':
      '导出的代码使用占位密钥请求 OpenAI 兼容的 /v1/chat/completions 接口；附件会替换为文件占位符，而不是 base64 字节。',
    'Messages JSON': 'Messages JSON',
    'No request captured': '尚未捕获请求',
    'Node.js': 'Node.js',
    Python: 'Python',
    'Request preview': '请求预览',
    'Send a message to inspect the exact request payload.':
      '发送一条消息即可查看实际的请求负载。',
    'The exact request built by the last send, ready to copy into your own code.':
      '最近一次发送实际构建的请求，可直接复制到自己的代码中。',
    'View the request payload of the last send': '查看最近一次发送的请求负载',
  },
  'zh-TW': {
    'Copy cURL': '複製 cURL',
    'Copy Messages JSON': '複製 Messages JSON',
    'Copy Node.js': '複製 Node.js',
    'Copy Python': '複製 Python',
    cURL: 'cURL',
    '"group" is a Playground-only routing field; the /v1 endpoint uses the API token group instead.':
      '「group」是 Playground 專用的路由欄位；/v1 介面改為從 API 金鑰讀取分組。',
    'Exports target the OpenAI-compatible /v1/chat/completions endpoint with a placeholder key. Attachments are replaced by file placeholders instead of base64 bytes.':
      '匯出的程式碼使用預留位置金鑰請求 OpenAI 相容的 /v1/chat/completions 介面；附件會替換為檔案預留位置，而不是 base64 位元組。',
    'Messages JSON': 'Messages JSON',
    'No request captured': '尚未擷取請求',
    'Node.js': 'Node.js',
    Python: 'Python',
    'Request preview': '請求預覽',
    'Send a message to inspect the exact request payload.':
      '傳送一則訊息即可查看實際的請求負載。',
    'The exact request built by the last send, ready to copy into your own code.':
      '最近一次傳送實際建構的請求，可直接複製到自己的程式碼中。',
    'View the request payload of the last send': '查看最近一次傳送的請求負載',
  },
  fr: {
    'Copy cURL': 'Copier la commande cURL',
    'Copy Messages JSON': 'Copier les messages JSON',
    'Copy Node.js': 'Copier le code Node.js',
    'Copy Python': 'Copier le code Python',
    cURL: 'cURL',
    '"group" is a Playground-only routing field; the /v1 endpoint uses the API token group instead.':
      "« group » est un champ de routage propre au Playground ; l'endpoint /v1 utilise à la place le groupe du jeton API.",
    'Exports target the OpenAI-compatible /v1/chat/completions endpoint with a placeholder key. Attachments are replaced by file placeholders instead of base64 bytes.':
      "Les exports ciblent l'endpoint compatible OpenAI /v1/chat/completions avec une clé fictive. Les pièces jointes sont remplacées par des fichiers de remplacement plutôt que par des octets base64.",
    'Messages JSON': 'Messages JSON',
    'No request captured': 'Aucune requête capturée',
    'Node.js': 'Node.js',
    Python: 'Python',
    'Request preview': 'Aperçu de la requête',
    'Send a message to inspect the exact request payload.':
      'Envoyez un message pour inspecter la charge utile exacte de la requête.',
    'The exact request built by the last send, ready to copy into your own code.':
      'La requête exacte construite lors du dernier envoi, prête à copier dans votre propre code.',
    'View the request payload of the last send':
      'Voir la charge utile de la dernière requête',
  },
  ja: {
    'Copy cURL': 'cURL をコピー',
    'Copy Messages JSON': 'Messages JSON をコピー',
    'Copy Node.js': 'Node.js をコピー',
    'Copy Python': 'Python をコピー',
    cURL: 'cURL',
    '"group" is a Playground-only routing field; the /v1 endpoint uses the API token group instead.':
      '「group」は Playground 専用のルーティングフィールドです。/v1 エンドポイントは代わりに API トークンのグループを使用します。',
    'Exports target the OpenAI-compatible /v1/chat/completions endpoint with a placeholder key. Attachments are replaced by file placeholders instead of base64 bytes.':
      'エクスポートはプレースホルダーのキーで OpenAI 互換の /v1/chat/completions エンドポイントを対象とします。添付ファイルは base64 バイトではなくファイルのプレースホルダーに置き換えられます。',
    'Messages JSON': 'Messages JSON',
    'No request captured': 'リクエストがまだありません',
    'Node.js': 'Node.js',
    Python: 'Python',
    'Request preview': 'リクエストプレビュー',
    'Send a message to inspect the exact request payload.':
      'メッセージを送信すると、実際のリクエストペイロードを確認できます。',
    'The exact request built by the last send, ready to copy into your own code.':
      '最後の送信で実際に組み立てられたリクエストを、そのまま自分のコードにコピーできます。',
    'View the request payload of the last send':
      '最後に送信したリクエストのペイロードを表示',
  },
  ru: {
    'Copy cURL': 'Скопировать cURL',
    'Copy Messages JSON': 'Скопировать Messages JSON',
    'Copy Node.js': 'Скопировать Node.js',
    'Copy Python': 'Скопировать Python',
    cURL: 'cURL',
    '"group" is a Playground-only routing field; the /v1 endpoint uses the API token group instead.':
      '«group» — поле маршрутизации, используемое только в Playground; эндпоинт /v1 вместо этого берёт группу из API-токена.',
    'Exports target the OpenAI-compatible /v1/chat/completions endpoint with a placeholder key. Attachments are replaced by file placeholders instead of base64 bytes.':
      'Экспорт обращается к OpenAI-совместимому эндпоинту /v1/chat/completions с ключом-заполнителем. Вложения заменяются заполнителями файлов вместо байтов base64.',
    'Messages JSON': 'Messages JSON',
    'No request captured': 'Запрос не зафиксирован',
    'Node.js': 'Node.js',
    Python: 'Python',
    'Request preview': 'Просмотр запроса',
    'Send a message to inspect the exact request payload.':
      'Отправьте сообщение, чтобы увидеть точное тело запроса.',
    'The exact request built by the last send, ready to copy into your own code.':
      'Точный запрос, собранный при последней отправке, готовый к копированию в ваш код.',
    'View the request payload of the last send':
      'Посмотреть тело запроса последней отправки',
  },
  vi: {
    'Copy cURL': 'Sao chép cURL',
    'Copy Messages JSON': 'Sao chép Messages JSON',
    'Copy Node.js': 'Sao chép Node.js',
    'Copy Python': 'Sao chép Python',
    cURL: 'cURL',
    '"group" is a Playground-only routing field; the /v1 endpoint uses the API token group instead.':
      '"group" là trường định tuyến riêng của Playground; endpoint /v1 thay vào đó lấy nhóm từ token API.',
    'Exports target the OpenAI-compatible /v1/chat/completions endpoint with a placeholder key. Attachments are replaced by file placeholders instead of base64 bytes.':
      'Bản xuất gửi tới endpoint /v1/chat/completions tương thích OpenAI với khóa giữ chỗ. Tệp đính kèm được thay bằng placeholder tệp thay vì byte base64.',
    'Messages JSON': 'Messages JSON',
    'No request captured': 'Chưa ghi lại yêu cầu nào',
    'Node.js': 'Node.js',
    Python: 'Python',
    'Request preview': 'Xem trước yêu cầu',
    'Send a message to inspect the exact request payload.':
      'Gửi một tin nhắn để xem nội dung yêu cầu thực tế.',
    'The exact request built by the last send, ready to copy into your own code.':
      'Yêu cầu chính xác được tạo ở lần gửi gần nhất, sẵn sàng để sao chép vào mã của bạn.',
    'View the request payload of the last send':
      'Xem nội dung yêu cầu của lần gửi gần nhất',
  },
}

async function main() {
  let totalAdded = 0

  for (const [locale, trans] of Object.entries(newKeys)) {
    const filePath = path.join(LOCALES_DIR, `${locale}.json`)
    const json = JSON.parse(await fs.readFile(filePath, 'utf8'))

    let count = 0
    for (const [key, value] of Object.entries(trans)) {
      if (!Object.prototype.hasOwnProperty.call(json.translation, key)) {
        json.translation[key] = value
        count++
      } else if (json.translation[key] !== value) {
        json.translation[key] = value
        count++
      }
    }

    if (count > 0) {
      json.translation = Object.fromEntries(
        Object.entries(json.translation).sort(([a], [b]) => a.localeCompare(b))
      )
      await fs.writeFile(filePath, stableStringify(json), 'utf8')
    }

    console.log(`${locale}: ${count} translations applied`)
    totalAdded += count
  }

  console.log(`\nTotal: ${totalAdded} translations applied`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
