import fs from 'node:fs/promises'
import path from 'node:path'

const LOCALES_DIR = path.resolve('src/i18n/locales')

function stableStringify(obj) {
  return JSON.stringify(obj, null, 2) + '\n'
}

const newKeys = {
  en: {
    'Referral commission revoked because the order payment was reversed: {{quota}}':
      'Referral commission revoked because the order payment was reversed: {{quota}}',
    'Referral commission reclaimed because the order payment was reversed: {{quota}}, debt added: {{debt}}':
      'Referral commission reclaimed because the order payment was reversed: {{quota}}, debt added: {{debt}}',
  },
  zh: {
    'Referral commission revoked because the order payment was reversed: {{quota}}':
      '订单支付已冲正，返佣已撤销：{{quota}}',
    'Referral commission reclaimed because the order payment was reversed: {{quota}}, debt added: {{debt}}':
      '订单支付已冲正，返佣已收回：{{quota}}，新增欠款：{{debt}}',
  },
  'zh-TW': {
    'Referral commission revoked because the order payment was reversed: {{quota}}':
      '訂單付款已沖正，返佣已撤銷：{{quota}}',
    'Referral commission reclaimed because the order payment was reversed: {{quota}}, debt added: {{debt}}':
      '訂單付款已沖正，返佣已收回：{{quota}}，新增欠款：{{debt}}',
  },
  fr: {
    'Referral commission revoked because the order payment was reversed: {{quota}}':
      'Paiement de commande annulé, commission de parrainage révoquée : {{quota}}',
    'Referral commission reclaimed because the order payment was reversed: {{quota}}, debt added: {{debt}}':
      'Paiement de commande annulé, commission de parrainage récupérée : {{quota}}, dette ajoutée : {{debt}}',
  },
  ja: {
    'Referral commission revoked because the order payment was reversed: {{quota}}':
      '注文の支払いが取り消されたため、紹介コミッションが無効になりました：{{quota}}',
    'Referral commission reclaimed because the order payment was reversed: {{quota}}, debt added: {{debt}}':
      '注文の支払いが取り消されたため、紹介コミッションを回収しました：{{quota}}、追加された債務：{{debt}}',
  },
  ru: {
    'Referral commission revoked because the order payment was reversed: {{quota}}':
      'Платёж по заказу отменён, комиссия за приглашения отозвана: {{quota}}',
    'Referral commission reclaimed because the order payment was reversed: {{quota}}, debt added: {{debt}}':
      'Платёж по заказу отменён, комиссия за приглашения взыскана: {{quota}}, добавленный долг: {{debt}}',
  },
  vi: {
    'Referral commission revoked because the order payment was reversed: {{quota}}':
      'Thanh toán đơn hàng đã bị đảo ngược, hoa hồng giới thiệu đã bị vô hiệu hóa: {{quota}}',
    'Referral commission reclaimed because the order payment was reversed: {{quota}}, debt added: {{debt}}':
      'Thanh toán đơn hàng đã bị đảo ngược, hoa hồng giới thiệu đã được thu hồi: {{quota}}, nợ tăng thêm: {{debt}}',
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
