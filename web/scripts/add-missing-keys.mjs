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
    'Apply background removal': 'Apply background removal',
    'Apply outpaint': 'Apply outpaint',
    'Apply style reference': 'Apply style reference',
    'Choose a model for background removal.':
      'Choose a model for background removal.',
    'Choose a model for the outpaint.': 'Choose a model for the outpaint.',
    'Choose a model for the style reference.':
      'Choose a model for the style reference.',
    'Choose a style image.': 'Choose a style image.',
    'Describe anything the background removal should preserve.':
      'Describe anything the background removal should preserve.',
    'Describe the result': 'Describe the result',
    'Describe the result you want from the style reference.':
      'Describe the result you want from the style reference.',
    'Extend the image into a new aspect ratio. The model fills the blank area.':
      'Extend the image into a new aspect ratio. The model fills the blank area.',
    'No available model advertises masked image edits.':
      'No available model advertises masked image edits.',
    'No available model advertises masked outpaint edits.':
      'No available model advertises masked outpaint edits.',
    'No available model advertises style-reference edits.':
      'No available model advertises style-reference edits.',
    'No available model advertises transparent-background removal.':
      'No available model advertises transparent-background removal.',
    'Outpaint image': 'Outpaint image',
    'Prompt (optional)': 'Prompt (optional)',
    'Remove background': 'Remove background',
    'Remove the background and keep the subject on transparency.':
      'Remove the background and keep the subject on transparency.',
    'Style image': 'Style image',
    'Target aspect ratio': 'Target aspect ratio',
    'Target size': 'Target size',
    'The selected model does not support this image tool.':
      'The selected model does not support this image tool.',
    'The selected model receives the image with a transparent background request.':
      'The selected model receives the image with a transparent background request.',
    'The source image keeps its pixels and is centered in the new canvas.':
      'The source image keeps its pixels and is centered in the new canvas.',
    'The style image is larger than the 8 MiB limit.':
      'The style image is larger than the 8 MiB limit.',
    'The style image must be a PNG, JPEG, WebP or GIF file.':
      'The style image must be a PNG, JPEG, WebP or GIF file.',
    'Use style reference': 'Use style reference',
    'Why some image tools are hidden': 'Why some image tools are hidden',
  },
  zh: {
    'Apply background removal': '应用背景移除',
    'Apply outpaint': '应用扩图',
    'Apply style reference': '应用风格参考',
    'Choose a model for background removal.': '请选择用于背景移除的模型。',
    'Choose a model for the outpaint.': '请选择用于扩图的模型。',
    'Choose a model for the style reference.': '请选择用于风格参考的模型。',
    'Choose a style image.': '请选择风格参考图。',
    'Describe anything the background removal should preserve.':
      '描述背景移除需要保留的内容。',
    'Describe the result': '描述结果',
    'Describe the result you want from the style reference.':
      '描述你希望风格参考生成的结果。',
    'Extend the image into a new aspect ratio. The model fills the blank area.':
      '将图片扩展到新的宽高比，模型会补全空白区域。',
    'No available model advertises masked image edits.':
      '没有可用模型声明支持蒙版图像编辑。',
    'No available model advertises masked outpaint edits.':
      '没有可用模型声明支持蒙版扩图编辑。',
    'No available model advertises style-reference edits.':
      '没有可用模型声明支持风格参考编辑。',
    'No available model advertises transparent-background removal.':
      '没有可用模型声明支持透明背景移除。',
    'Outpaint image': '扩图',
    'Prompt (optional)': '提示词（可选）',
    'Remove background': '移除背景',
    'Remove the background and keep the subject on transparency.':
      '移除背景，将主体保留为透明背景。',
    'Style image': '风格参考图',
    'Target aspect ratio': '目标宽高比',
    'Target size': '目标尺寸',
    'The selected model does not support this image tool.':
      '所选模型不支持此图像工具。',
    'The selected model receives the image with a transparent background request.':
      '所选模型将收到带有透明背景请求的图片。',
    'The source image keeps its pixels and is centered in the new canvas.':
      '原图保持原有像素并居中放置在新画布中。',
    'The style image is larger than the 8 MiB limit.':
      '风格参考图超过 8 MiB 限制。',
    'The style image must be a PNG, JPEG, WebP or GIF file.':
      '风格参考图必须是 PNG、JPEG、WebP 或 GIF 文件。',
    'Use style reference': '使用风格参考',
    'Why some image tools are hidden': '为什么部分图像工具被隐藏',
  },
  'zh-TW': {
    'Apply background removal': '套用背景移除',
    'Apply outpaint': '套用擴圖',
    'Apply style reference': '套用風格參考',
    'Choose a model for background removal.': '請選擇用於背景移除的模型。',
    'Choose a model for the outpaint.': '請選擇用於擴圖的模型。',
    'Choose a model for the style reference.': '請選擇用於風格參考的模型。',
    'Choose a style image.': '請選擇風格參考圖。',
    'Describe anything the background removal should preserve.':
      '描述背景移除需要保留的內容。',
    'Describe the result': '描述結果',
    'Describe the result you want from the style reference.':
      '描述你希望風格參考產生的結果。',
    'Extend the image into a new aspect ratio. The model fills the blank area.':
      '將圖片擴展到新的長寬比，模型會補全空白區域。',
    'No available model advertises masked image edits.':
      '沒有可用模型宣告支援遮罩圖片編輯。',
    'No available model advertises masked outpaint edits.':
      '沒有可用模型宣告支援遮罩擴圖編輯。',
    'No available model advertises style-reference edits.':
      '沒有可用模型宣告支援風格參考編輯。',
    'No available model advertises transparent-background removal.':
      '沒有可用模型宣告支援透明背景移除。',
    'Outpaint image': '擴圖',
    'Prompt (optional)': '提示詞（選填）',
    'Remove background': '移除背景',
    'Remove the background and keep the subject on transparency.':
      '移除背景，將主體保留為透明背景。',
    'Style image': '風格參考圖',
    'Target aspect ratio': '目標長寬比',
    'Target size': '目標尺寸',
    'The selected model does not support this image tool.':
      '所選模型不支援此圖片工具。',
    'The selected model receives the image with a transparent background request.':
      '所選模型將收到帶有透明背景請求的圖片。',
    'The source image keeps its pixels and is centered in the new canvas.':
      '原圖保持原有像素並置中於新畫布中。',
    'The style image is larger than the 8 MiB limit.':
      '風格參考圖超過 8 MiB 限制。',
    'The style image must be a PNG, JPEG, WebP or GIF file.':
      '風格參考圖必須是 PNG、JPEG、WebP 或 GIF 檔案。',
    'Use style reference': '使用風格參考',
    'Why some image tools are hidden': '為什麼部分圖片工具被隱藏',
  },
  fr: {
    'Apply background removal': 'Appliquer la suppression du fond',
    'Apply outpaint': "Appliquer l'extension d'image",
    'Apply style reference': 'Appliquer la référence de style',
    'Choose a model for background removal.':
      'Choisissez un modèle pour la suppression du fond.',
    'Choose a model for the outpaint.':
      "Choisissez un modèle pour l'extension d'image.",
    'Choose a model for the style reference.':
      'Choisissez un modèle pour la référence de style.',
    'Choose a style image.': 'Choisissez une image de style.',
    'Describe anything the background removal should preserve.':
      'Décrivez ce que la suppression du fond doit préserver.',
    'Describe the result': 'Décrivez le résultat',
    'Describe the result you want from the style reference.':
      'Décrivez le résultat souhaité à partir de la référence de style.',
    'Extend the image into a new aspect ratio. The model fills the blank area.':
      "Étendez l'image vers un nouveau rapport d'aspect. Le modèle remplit la zone vide.",
    'No available model advertises masked image edits.':
      "Aucun modèle disponible n'annonce de retouches d'image avec masque.",
    'No available model advertises masked outpaint edits.':
      "Aucun modèle disponible n'annonce d'extension d'image avec masque.",
    'No available model advertises style-reference edits.':
      "Aucun modèle disponible n'annonce de retouches par référence de style.",
    'No available model advertises transparent-background removal.':
      "Aucun modèle disponible n'annonce la suppression du fond transparent.",
    'Outpaint image': "Étendre l'image",
    'Prompt (optional)': 'Invite (facultatif)',
    'Remove background': 'Supprimer le fond',
    'Remove the background and keep the subject on transparency.':
      'Supprimez le fond et conservez le sujet sur un fond transparent.',
    'Style image': 'Image de style',
    'Target aspect ratio': "Rapport d'aspect cible",
    'Target size': 'Taille cible',
    'The selected model does not support this image tool.':
      "Le modèle sélectionné ne prend pas en charge cet outil d'image.",
    'The selected model receives the image with a transparent background request.':
      "Le modèle sélectionné reçoit l'image avec une demande de fond transparent.",
    'The source image keeps its pixels and is centered in the new canvas.':
      "L'image source conserve ses pixels et est centrée dans le nouveau canevas.",
    'The style image is larger than the 8 MiB limit.':
      "L'image de style dépasse la limite de 8 Mio.",
    'The style image must be a PNG, JPEG, WebP or GIF file.':
      "L'image de style doit être un fichier PNG, JPEG, WebP ou GIF.",
    'Use style reference': 'Utiliser une référence de style',
    'Why some image tools are hidden':
      "Pourquoi certains outils d'image sont masqués",
  },
  ja: {
    'Apply background removal': '背景除去を適用',
    'Apply outpaint': 'アウトペイントを適用',
    'Apply style reference': 'スタイル参照を適用',
    'Choose a model for background removal.':
      '背景除去に使用するモデルを選択してください。',
    'Choose a model for the outpaint.':
      'アウトペイントに使用するモデルを選択してください。',
    'Choose a model for the style reference.':
      'スタイル参照に使用するモデルを選択してください。',
    'Choose a style image.': 'スタイル画像を選択してください。',
    'Describe anything the background removal should preserve.':
      '背景除去で保持したい内容を入力してください。',
    'Describe the result': '結果の説明',
    'Describe the result you want from the style reference.':
      'スタイル参照で得たい結果を説明してください。',
    'Extend the image into a new aspect ratio. The model fills the blank area.':
      '画像を新しいアスペクト比に拡張します。空白部分はモデルが補完します。',
    'No available model advertises masked image edits.':
      'マスク画像編集に対応するモデルがありません。',
    'No available model advertises masked outpaint edits.':
      'マスクを使ったアウトペイントに対応するモデルがありません。',
    'No available model advertises style-reference edits.':
      'スタイル参照編集に対応するモデルがありません。',
    'No available model advertises transparent-background removal.':
      '透明背景の除去に対応するモデルがありません。',
    'Outpaint image': '画像をアウトペイント',
    'Prompt (optional)': 'プロンプト（任意）',
    'Remove background': '背景を削除',
    'Remove the background and keep the subject on transparency.':
      '背景を削除し、被写体を透明な状態で保持します。',
    'Style image': 'スタイル画像',
    'Target aspect ratio': '目標のアスペクト比',
    'Target size': '目標サイズ',
    'The selected model does not support this image tool.':
      '選択したモデルはこの画像ツールに対応していません。',
    'The selected model receives the image with a transparent background request.':
      '選択したモデルには、透明背景のリクエストとともに画像が送信されます。',
    'The source image keeps its pixels and is centered in the new canvas.':
      '元の画像は画素を保ったまま、新しいキャンバスの中央に配置されます。',
    'The style image is larger than the 8 MiB limit.':
      'スタイル画像が 8 MiB の上限を超えています。',
    'The style image must be a PNG, JPEG, WebP or GIF file.':
      'スタイル画像は PNG、JPEG、WebP、GIF のいずれかである必要があります。',
    'Use style reference': 'スタイル参照を使用',
    'Why some image tools are hidden':
      '一部の画像ツールが非表示になっている理由',
  },
  ru: {
    'Apply background removal': 'Применить удаление фона',
    'Apply outpaint': 'Применить расширение изображения',
    'Apply style reference': 'Применить стилевую ссылку',
    'Choose a model for background removal.':
      'Выберите модель для удаления фона.',
    'Choose a model for the outpaint.':
      'Выберите модель для расширения изображения.',
    'Choose a model for the style reference.':
      'Выберите модель для стилевой ссылки.',
    'Choose a style image.': 'Выберите изображение стиля.',
    'Describe anything the background removal should preserve.':
      'Опишите, что нужно сохранить при удалении фона.',
    'Describe the result': 'Опишите результат',
    'Describe the result you want from the style reference.':
      'Опишите результат, который хотите получить с помощью стилевой ссылки.',
    'Extend the image into a new aspect ratio. The model fills the blank area.':
      'Расширьте изображение до нового соотношения сторон. Модель заполнит пустую область.',
    'No available model advertises masked image edits.':
      'Ни одна доступная модель не заявляет редактирование изображений с маской.',
    'No available model advertises masked outpaint edits.':
      'Ни одна доступная модель не заявляет расширение изображений с маской.',
    'No available model advertises style-reference edits.':
      'Ни одна доступная модель не заявляет редактирование по стилевой ссылке.',
    'No available model advertises transparent-background removal.':
      'Ни одна доступная модель не заявляет удаление фона до прозрачного.',
    'Outpaint image': 'Расширить изображение',
    'Prompt (optional)': 'Запрос (необязательно)',
    'Remove background': 'Удалить фон',
    'Remove the background and keep the subject on transparency.':
      'Удалите фон и сохраните объект на прозрачном фоне.',
    'Style image': 'Изображение стиля',
    'Target aspect ratio': 'Целевое соотношение сторон',
    'Target size': 'Целевой размер',
    'The selected model does not support this image tool.':
      'Выбранная модель не поддерживает этот инструмент изображений.',
    'The selected model receives the image with a transparent background request.':
      'Выбранная модель получает изображение с запросом прозрачного фона.',
    'The source image keeps its pixels and is centered in the new canvas.':
      'Исходное изображение сохраняет свои пиксели и размещается по центру нового холста.',
    'The style image is larger than the 8 MiB limit.':
      'Изображение стиля превышает лимит 8 МиБ.',
    'The style image must be a PNG, JPEG, WebP or GIF file.':
      'Изображение стиля должно быть файлом PNG, JPEG, WebP или GIF.',
    'Use style reference': 'Использовать стилевую ссылку',
    'Why some image tools are hidden':
      'Почему некоторые инструменты изображений скрыты',
  },
  vi: {
    'Apply background removal': 'Áp dụng xóa nền',
    'Apply outpaint': 'Áp dụng mở rộng ảnh',
    'Apply style reference': 'Áp dụng tham chiếu phong cách',
    'Choose a model for background removal.': 'Chọn model để xóa nền.',
    'Choose a model for the outpaint.': 'Chọn model để mở rộng ảnh.',
    'Choose a model for the style reference.':
      'Chọn model cho tham chiếu phong cách.',
    'Choose a style image.': 'Chọn ảnh phong cách.',
    'Describe anything the background removal should preserve.':
      'Mô tả những gì cần giữ lại khi xóa nền.',
    'Describe the result': 'Mô tả kết quả',
    'Describe the result you want from the style reference.':
      'Mô tả kết quả bạn muốn từ tham chiếu phong cách.',
    'Extend the image into a new aspect ratio. The model fills the blank area.':
      'Mở rộng ảnh sang tỷ lệ khung hình mới. Model sẽ lấp đầy vùng trống.',
    'No available model advertises masked image edits.':
      'Không có model khả dụng nào hỗ trợ chỉnh sửa ảnh bằng mặt nạ.',
    'No available model advertises masked outpaint edits.':
      'Không có model khả dụng nào hỗ trợ mở rộng ảnh bằng mặt nạ.',
    'No available model advertises style-reference edits.':
      'Không có model khả dụng nào hỗ trợ chỉnh sửa theo tham chiếu phong cách.',
    'No available model advertises transparent-background removal.':
      'Không có model khả dụng nào hỗ trợ xóa nền trong suốt.',
    'Outpaint image': 'Mở rộng ảnh',
    'Prompt (optional)': 'Gợi ý (tùy chọn)',
    'Remove background': 'Xóa nền',
    'Remove the background and keep the subject on transparency.':
      'Xóa nền và giữ chủ thể trên nền trong suốt.',
    'Style image': 'Ảnh phong cách',
    'Target aspect ratio': 'Tỷ lệ khung hình mục tiêu',
    'Target size': 'Kích thước mục tiêu',
    'The selected model does not support this image tool.':
      'Model đã chọn không hỗ trợ công cụ ảnh này.',
    'The selected model receives the image with a transparent background request.':
      'Model đã chọn nhận ảnh kèm yêu cầu nền trong suốt.',
    'The source image keeps its pixels and is centered in the new canvas.':
      'Ảnh gốc giữ nguyên điểm ảnh và được đặt giữa canvas mới.',
    'The style image is larger than the 8 MiB limit.':
      'Ảnh phong cách vượt quá giới hạn 8 MiB.',
    'The style image must be a PNG, JPEG, WebP or GIF file.':
      'Ảnh phong cách phải là tệp PNG, JPEG, WebP hoặc GIF.',
    'Use style reference': 'Dùng tham chiếu phong cách',
    'Why some image tools are hidden': 'Vì sao một số công cụ ảnh bị ẩn',
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
