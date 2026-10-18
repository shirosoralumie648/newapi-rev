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
    '0 means unlimited.': '0 means unlimited.',
    'All accounts': 'All accounts',
    'Apply the user group ratio': 'Apply the user group ratio',
    Billed: 'Billed',
    Charge: 'Charge',
    'Charged per downloaded GB when egress is metered.':
      'Charged per downloaded GB when egress is metered.',
    'Daily download limit (bytes)': 'Daily download limit (bytes)',
    'Daily download request limit': 'Daily download request limit',
    'Daily storage charges will appear here':
      'Daily storage charges will appear here',
    Date: 'Date',
    Debt: 'Debt',
    'Downloaded today': 'Downloaded today',
    'Egress mode': 'Egress mode',
    'Egress price per GB (USD)': 'Egress price per GB (USD)',
    Egress: 'Egress',
    'Enable metered storage billing': 'Enable metered storage billing',
    'End date': 'End date',
    'Enter a non-negative whole number.': 'Enter a non-negative whole number.',
    'Failed to export the storage ledger':
      'Failed to export the storage ledger',
    'Failed to load the storage ledger': 'Failed to load the storage ledger',
    'Failed to reconcile the storage ledger':
      'Failed to reconcile the storage ledger',
    'Free allowance (GB)': 'Free allowance (GB)',
    'Free allowance per account (GB)': 'Free allowance per account (GB)',
    'Grace period (days)': 'Grace period (days)',
    'Group free storage overrides': 'Group free storage overrides',
    Metered: 'Metered',
    'No storage ledger entries found': 'No storage ledger entries found',
    'Open storage ledger': 'Open storage ledger',
    'Peak stored today': 'Peak stored today',
    'Playground Storage Billing': 'Playground Storage Billing',
    Reconcile: 'Reconcile',
    'Reconciling...': 'Reconciling...',
    'Start date': 'Start date',
    'Storage billing': 'Storage billing',
    'Storage charges match the wallet ledger.':
      'Storage charges match the wallet ledger.',
    'Storage ledger exported': 'Storage ledger exported',
    'Storage ledger': 'Storage ledger',
    'Storage price per GB-month (USD)': 'Storage price per GB-month (USD)',
    Unmetered: 'Unmetered',
    'Your wallet has an unpaid balance, so uploading new Playground data is read-only until you top up.':
      'Your wallet has an unpaid balance, so uploading new Playground data is read-only until you top up.',
    'Unmetered still enforces the daily limits; metered also charges the downloaded GBs.':
      'Unmetered still enforces the daily limits; metered also charges the downloaded GBs.',
    'A day whose charge the wallet cannot cover becomes wallet debt and the account becomes read-only; it recovers automatically after a top-up. Stored data is never deleted.':
      'A day whose charge the wallet cannot cover becomes wallet debt and the account becomes read-only; it recovers automatically after a top-up. Stored data is never deleted.',
    'Count the bytes users download from Playground storage. A metered price bills them with the daily settlement; the daily limits refuse the transfer that would cross them.':
      'Count the bytes users download from Playground storage. A metered price bills them with the daily settlement; the daily limits refuse the transfer that would cross them.',
    'Give one user group a different free allowance. A group without an entry uses the global allowance.':
      'Give one user group a different free allowance. A group without an entry uses the global allowance.',
    'One GB-day costs one thirtieth of this monthly price. Stored bytes are charged from the wallet, never silently deleted.':
      'One GB-day costs one thirtieth of this monthly price. Stored bytes are charged from the wallet, never silently deleted.',
    'Review, export and reconcile the daily storage charges the gateway recorded.':
      'Review, export and reconcile the daily storage charges the gateway recorded.',
    'Stored bytes up to this allowance are free; only the part above it is billed.':
      'Stored bytes up to this allowance are free; only the part above it is billed.',
    'Charge each account the peak bytes it stores per day and record the daily charge in the wallet ledger. Disabled by default.':
      'Charge each account the peak bytes it stores per day and record the daily charge in the wallet ledger. Disabled by default.',
    'Multiply storage and egress charges by the account group ratio, the same ratio the relay uses for model prices.':
      'Multiply storage and egress charges by the account group ratio, the same ratio the relay uses for model prices.',
    'Found {{count}} accounts whose storage charges deviate from the wallet ledger.':
      'Found {{count}} accounts whose storage charges deviate from the wallet ledger.',
    'Daily metered storage charges, their free allowance and the wallet debt they raised':
      'Daily metered storage charges, their free allowance and the wallet debt they raised',
    'Save storage billing': 'Save storage billing',
    Grace: 'Grace',
    'Playground storage billing for {{date}}: {{quota}} quota charged, {{bytes}} bytes billed':
      'Playground storage billing for {{date}}: {{quota}} quota charged, {{bytes}} bytes billed',
  },
  zh: {
    '0 means unlimited.': '0 表示无限制。',
    'All accounts': '全部账户',
    'Apply the user group ratio': '应用用户分组倍率',
    Billed: '计费',
    Charge: '费用',
    'Charged per downloaded GB when egress is metered.':
      '出站流量计量开启时，按下载的每 GB 计费。',
    'Daily download limit (bytes)': '每日下载上限（字节）',
    'Daily download request limit': '每日下载请求上限',
    'Daily storage charges will appear here': '每日存储费用将显示在这里',
    Date: '日期',
    Debt: '欠款',
    'Downloaded today': '今日下载',
    'Egress mode': '出站流量模式',
    'Egress price per GB (USD)': '出站流量价格（USD/GB）',
    Egress: '出站流量',
    'Enable metered storage billing': '启用存储计量计费',
    'End date': '结束日期',
    'Enter a non-negative whole number.': '请输入非负整数。',
    'Failed to export the storage ledger': '导出存储账本失败',
    'Failed to load the storage ledger': '加载存储账本失败',
    'Failed to reconcile the storage ledger': '对账存储账本失败',
    'Free allowance (GB)': '免费额度（GB）',
    'Free allowance per account (GB)': '每个账户的免费额度（GB）',
    'Grace period (days)': '宽限期（天）',
    'Group free storage overrides': '分组免费存储覆盖',
    Metered: '计量',
    'No storage ledger entries found': '没有存储账本记录',
    'Open storage ledger': '打开存储账本',
    'Peak stored today': '今日存储峰值',
    'Playground Storage Billing': 'Playground 存储计费',
    Reconcile: '对账',
    'Reconciling...': '对账中...',
    'Start date': '开始日期',
    'Storage billing': '存储计费',
    'Storage charges match the wallet ledger.': '存储费用与钱包账本一致。',
    'Storage ledger exported': '存储账本已导出',
    'Storage ledger': '存储账本',
    'Storage price per GB-month (USD)': '存储价格（USD/GB-月）',
    Unmetered: '不计量',
    'Your wallet has an unpaid balance, so uploading new Playground data is read-only until you top up.':
      '你的钱包有未结清欠款，充值前上传新的 Playground 数据为只读状态。',
    'Unmetered still enforces the daily limits; metered also charges the downloaded GBs.':
      '不计量模式仍会执行每日上限；计量模式还会对已下载的 GB 计费。',
    'A day whose charge the wallet cannot cover becomes wallet debt and the account becomes read-only; it recovers automatically after a top-up. Stored data is never deleted.':
      '钱包无法覆盖某日费用的部分将记为钱包欠款，账户进入只读状态；充值后自动恢复。已存储的数据不会被删除。',
    'Count the bytes users download from Playground storage. A metered price bills them with the daily settlement; the daily limits refuse the transfer that would cross them.':
      '统计用户从 Playground 存储下载的字节数。计量价格会在每日结算时计入费用；超出每日上限的下载会被拒绝。',
    'Give one user group a different free allowance. A group without an entry uses the global allowance.':
      '为某个用户分组设置不同的免费额度。未配置的分组使用全局额度。',
    'One GB-day costs one thirtieth of this monthly price. Stored bytes are charged from the wallet, never silently deleted.':
      '每 GB-天按此月单价的三十分之一计费。存储字节从钱包扣费，绝不会被静默删除。',
    'Review, export and reconcile the daily storage charges the gateway recorded.':
      '查看、导出并核对网关记录的每日存储费用。',
    'Stored bytes up to this allowance are free; only the part above it is billed.':
      '额度以内的存储字节免费，仅对超出部分计费。',
    'Charge each account the peak bytes it stores per day and record the daily charge in the wallet ledger. Disabled by default.':
      '按每个账户每日存储峰值的字节数计费，并将每日费用记入钱包账本。默认关闭。',
    'Multiply storage and egress charges by the account group ratio, the same ratio the relay uses for model prices.':
      '存储和出站流量费用乘以账户的分组倍率，与中转用于模型价格的倍率一致。',
    'Found {{count}} accounts whose storage charges deviate from the wallet ledger.':
      '发现 {{count}} 个账户的存储费用与钱包账本不一致。',
    'Daily metered storage charges, their free allowance and the wallet debt they raised':
      '每日计量的存储费用、其免费额度以及产生的钱包欠款',
    'Save storage billing': '保存存储计费设置',
    Grace: '宽限期',
    'Playground storage billing for {{date}}: {{quota}} quota charged, {{bytes}} bytes billed':
      '{{date}} 的 Playground 存储计费：已扣 {{quota}} 额度，计费 {{bytes}} 字节',
  },
  'zh-TW': {
    '0 means unlimited.': '0 表示無限制。',
    'All accounts': '全部帳戶',
    'Apply the user group ratio': '套用用戶分組倍率',
    Billed: '計費',
    Charge: '費用',
    'Charged per downloaded GB when egress is metered.':
      '出站流量計量開啟時，按已下載的每 GB 計費。',
    'Daily download limit (bytes)': '每日下載上限（位元組）',
    'Daily download request limit': '每日下載請求上限',
    'Daily storage charges will appear here': '每日儲存費用將顯示在這裡',
    Date: '日期',
    Debt: '欠款',
    'Downloaded today': '今日下載',
    'Egress mode': '出站流量模式',
    'Egress price per GB (USD)': '出站流量價格（USD/GB）',
    Egress: '出站流量',
    'Enable metered storage billing': '啟用儲存計量計費',
    'End date': '結束日期',
    'Enter a non-negative whole number.': '請輸入非負整數。',
    'Failed to export the storage ledger': '匯出儲存帳本失敗',
    'Failed to load the storage ledger': '載入儲存帳本失敗',
    'Failed to reconcile the storage ledger': '對帳儲存帳本失敗',
    'Free allowance (GB)': '免費額度（GB）',
    'Free allowance per account (GB)': '每個帳戶的免費額度（GB）',
    'Grace period (days)': '寬限期（天）',
    'Group free storage overrides': '分組免費儲存覆寫',
    Metered: '計量',
    'No storage ledger entries found': '沒有儲存帳本記錄',
    'Open storage ledger': '開啟儲存帳本',
    'Peak stored today': '今日儲存峰值',
    'Playground Storage Billing': 'Playground 儲存計費',
    Reconcile: '對帳',
    'Reconciling...': '對帳中...',
    'Start date': '開始日期',
    'Storage billing': '儲存計費',
    'Storage charges match the wallet ledger.': '儲存費用與錢包帳本一致。',
    'Storage ledger exported': '儲存帳本已匯出',
    'Storage ledger': '儲存帳本',
    'Storage price per GB-month (USD)': '儲存價格（USD/GB-月）',
    Unmetered: '不計量',
    'Your wallet has an unpaid balance, so uploading new Playground data is read-only until you top up.':
      '你的錢包有未結清欠款，儲值前上傳新的 Playground 資料為唯讀狀態。',
    'Unmetered still enforces the daily limits; metered also charges the downloaded GBs.':
      '不計量模式仍會執行每日上限；計量模式還會對已下載的 GB 計費。',
    'A day whose charge the wallet cannot cover becomes wallet debt and the account becomes read-only; it recovers automatically after a top-up. Stored data is never deleted.':
      '錢包無法負擔某日費用的部分將記為錢包欠款，帳戶進入唯讀狀態；儲值後自動恢復。已儲存的資料不會被刪除。',
    'Count the bytes users download from Playground storage. A metered price bills them with the daily settlement; the daily limits refuse the transfer that would cross them.':
      '統計用戶從 Playground 儲存下載的位元組數。計量價格會在每日結算時計入費用；超出每日上限的下載會被拒絕。',
    'Give one user group a different free allowance. A group without an entry uses the global allowance.':
      '為某個用戶分組設定不同的免費額度。未設定的分組使用全域額度。',
    'One GB-day costs one thirtieth of this monthly price. Stored bytes are charged from the wallet, never silently deleted.':
      '每 GB-天按此月單價的三十分之一計費。儲存的位元組從錢包扣費，絕不會被無聲刪除。',
    'Review, export and reconcile the daily storage charges the gateway recorded.':
      '檢視、匯出並核對閘道記錄的每日儲存費用。',
    'Stored bytes up to this allowance are free; only the part above it is billed.':
      '額度以內的儲存位元組免費，僅對超出部分計費。',
    'Charge each account the peak bytes it stores per day and record the daily charge in the wallet ledger. Disabled by default.':
      '按每個帳戶每日儲存峰值的位元組數計費，並將每日費用記入錢包帳本。預設關閉。',
    'Multiply storage and egress charges by the account group ratio, the same ratio the relay uses for model prices.':
      '儲存和出站流量費用乘以帳戶的分組倍率，與中轉用於模型價格的倍率一致。',
    'Found {{count}} accounts whose storage charges deviate from the wallet ledger.':
      '發現 {{count}} 個帳戶的儲存費用與錢包帳本不一致。',
    'Daily metered storage charges, their free allowance and the wallet debt they raised':
      '每日計量的儲存費用、其免費額度以及產生的錢包欠款',
    'Save storage billing': '儲存儲存空間計費設定',
    Grace: '寬限期',
    'Playground storage billing for {{date}}: {{quota}} quota charged, {{bytes}} bytes billed':
      '{{date}} 的 Playground 儲存計費：已扣 {{quota}} 額度，計費 {{bytes}} 位元組',
  },
  fr: {
    '0 means unlimited.': '0 signifie illimité.',
    'All accounts': 'Tous les comptes',
    'Apply the user group ratio': "Appliquer le ratio du groupe d'utilisateurs",
    Billed: 'Facturé',
    Charge: 'Frais',
    'Charged per downloaded GB when egress is metered.':
      'Facturé par Go téléchargé lorsque le trafic sortant est mesuré.',
    'Daily download limit (bytes)':
      'Limite de téléchargement quotidienne (octets)',
    'Daily download request limit':
      'Limite quotidienne de requêtes de téléchargement',
    'Daily storage charges will appear here':
      'Les frais de stockage quotidiens apparaîtront ici',
    Date: 'Date',
    Debt: 'Dette',
    'Downloaded today': "Téléchargé aujourd'hui",
    'Egress mode': 'Mode de trafic sortant',
    'Egress price per GB (USD)': 'Prix du trafic sortant par Go (USD)',
    Egress: 'Trafic sortant',
    'Enable metered storage billing':
      'Activer la facturation au compteur du stockage',
    'End date': 'Date de fin',
    'Enter a non-negative whole number.':
      'Saisissez un nombre entier positif ou nul.',
    'Failed to export the storage ledger':
      "Échec de l'exportation du registre de stockage",
    'Failed to load the storage ledger':
      'Échec du chargement du registre de stockage',
    'Failed to reconcile the storage ledger':
      'Échec du rapprochement du registre de stockage',
    'Free allowance (GB)': 'Allocation gratuite (Go)',
    'Free allowance per account (GB)': 'Allocation gratuite par compte (Go)',
    'Grace period (days)': 'Période de grâce (jours)',
    'Group free storage overrides':
      'Dérogations de stockage gratuit par groupe',
    Metered: 'Au compteur',
    'No storage ledger entries found': 'Aucune entrée de registre de stockage',
    'Open storage ledger': 'Ouvrir le registre de stockage',
    'Peak stored today': "Pic de stockage aujourd'hui",
    'Playground Storage Billing': 'Facturation du stockage Playground',
    Reconcile: 'Rapprocher',
    'Reconciling...': 'Rapprochement...',
    'Start date': 'Date de début',
    'Storage billing': 'Facturation du stockage',
    'Storage charges match the wallet ledger.':
      'Les frais de stockage correspondent au registre du portefeuille.',
    'Storage ledger exported': 'Registre de stockage exporté',
    'Storage ledger': 'Registre de stockage',
    'Storage price per GB-month (USD)': 'Prix du stockage par Go-mois (USD)',
    Unmetered: 'Non mesuré',
    'Your wallet has an unpaid balance, so uploading new Playground data is read-only until you top up.':
      "Votre portefeuille présente un solde impayé ; l'import de nouvelles données Playground est en lecture seule jusqu'à la recharge.",
    'Unmetered still enforces the daily limits; metered also charges the downloaded GBs.':
      'Le mode non mesuré applique quand même les limites quotidiennes ; le mode au compteur facture en plus les Go téléchargés.',
    'A day whose charge the wallet cannot cover becomes wallet debt and the account becomes read-only; it recovers automatically after a top-up. Stored data is never deleted.':
      "La part des frais qu'un portefeuille ne peut pas couvrir devient une dette du portefeuille et le compte passe en lecture seule ; il se rétablit automatiquement après une recharge. Les données stockées ne sont jamais supprimées.",
    'Count the bytes users download from Playground storage. A metered price bills them with the daily settlement; the daily limits refuse the transfer that would cross them.':
      'Compte les octets téléchargés depuis le stockage Playground. Un prix au compteur les facture lors du règlement quotidien ; les limites quotidiennes refusent le transfert qui les dépasserait.',
    'Give one user group a different free allowance. A group without an entry uses the global allowance.':
      "Accorder à un groupe d'utilisateurs une allocation gratuite différente. Un groupe sans entrée utilise l'allocation globale.",
    'One GB-day costs one thirtieth of this monthly price. Stored bytes are charged from the wallet, never silently deleted.':
      'Un Go-jour coûte un trentième de ce prix mensuel. Les octets stockés sont facturés au portefeuille et ne sont jamais supprimés silencieusement.',
    'Review, export and reconcile the daily storage charges the gateway recorded.':
      'Consultez, exportez et rapprochez les frais de stockage quotidiens enregistrés par la passerelle.',
    'Stored bytes up to this allowance are free; only the part above it is billed.':
      "Les octets stockés jusqu'à cette allocation sont gratuits ; seule la partie au-delà est facturée.",
    'Charge each account the peak bytes it stores per day and record the daily charge in the wallet ledger. Disabled by default.':
      'Facture à chaque compte les octets de pointe stockés par jour et enregistre les frais quotidiens dans le registre du portefeuille. Désactivé par défaut.',
    'Multiply storage and egress charges by the account group ratio, the same ratio the relay uses for model prices.':
      'Multiplie les frais de stockage et de trafic sortant par le ratio du groupe du compte, le même ratio que le relais applique aux prix des modèles.',
    'Found {{count}} accounts whose storage charges deviate from the wallet ledger.':
      '{{count}} comptes présentent des frais de stockage différents du registre du portefeuille.',
    'Daily metered storage charges, their free allowance and the wallet debt they raised':
      'Frais de stockage quotidiens au compteur, leur allocation gratuite et la dette de portefeuille engendrée',
    'Save storage billing': 'Enregistrer la facturation du stockage',
    Grace: 'En grâce',
    'Playground storage billing for {{date}}: {{quota}} quota charged, {{bytes}} bytes billed':
      'Facturation du stockage Playground du {{date}} : {{quota}} de quota facturé, {{bytes}} octets facturés',
  },
  ja: {
    '0 means unlimited.': '0 は無制限を意味します。',
    'All accounts': 'すべてのアカウント',
    'Apply the user group ratio': 'ユーザーグループ比率を適用',
    Billed: '課金対象',
    Charge: '料金',
    'Charged per downloaded GB when egress is metered.':
      'エグレスが従量制の場合、ダウンロードした GB ごとに課金されます。',
    'Daily download limit (bytes)': '1 日のダウンロード上限（バイト）',
    'Daily download request limit': '1 日のダウンロードリクエスト上限',
    'Daily storage charges will appear here':
      '日次のストレージ料金がここに表示されます',
    Date: '日付',
    Debt: '債務',
    'Downloaded today': '本日のダウンロード',
    'Egress mode': 'エグレスモード',
    'Egress price per GB (USD)': 'エグレスの GB 単価（USD）',
    Egress: 'エグレス',
    'Enable metered storage billing': 'ストレージの従量課金を有効化',
    'End date': '終了日',
    'Enter a non-negative whole number.': '0 以上の整数を入力してください。',
    'Failed to export the storage ledger':
      'ストレージ台帳のエクスポートに失敗しました',
    'Failed to load the storage ledger': 'ストレージ台帳を読み込めませんでした',
    'Failed to reconcile the storage ledger':
      'ストレージ台帳の照合に失敗しました',
    'Free allowance (GB)': '無料枠（GB）',
    'Free allowance per account (GB)': 'アカウントごとの無料枠（GB）',
    'Grace period (days)': '猶予期間（日）',
    'Group free storage overrides': 'グループ別の無料ストレージ上書き',
    Metered: '従量制',
    'No storage ledger entries found': 'ストレージ台帳の記録がありません',
    'Open storage ledger': 'ストレージ台帳を開く',
    'Peak stored today': '本日のストレージピーク',
    'Playground Storage Billing': 'Playground ストレージ課金',
    Reconcile: '照合',
    'Reconciling...': '照合中...',
    'Start date': '開始日',
    'Storage billing': 'ストレージ課金',
    'Storage charges match the wallet ledger.':
      'ストレージ料金はウォレット台帳と一致しています。',
    'Storage ledger exported': 'ストレージ台帳をエクスポートしました',
    'Storage ledger': 'ストレージ台帳',
    'Storage price per GB-month (USD)': 'ストレージ単価（USD/GB-月）',
    Unmetered: '非従量制',
    'Your wallet has an unpaid balance, so uploading new Playground data is read-only until you top up.':
      'ウォレットに未精算の残高があるため、チャージするまで新しい Playground データのアップロードは読み取り専用です。',
    'Unmetered still enforces the daily limits; metered also charges the downloaded GBs.':
      '非従量制でも 1 日の上限は適用されます。従量制ではダウンロードした GB も課金されます。',
    'A day whose charge the wallet cannot cover becomes wallet debt and the account becomes read-only; it recovers automatically after a top-up. Stored data is never deleted.':
      'ウォレットで支払えない日の料金はウォレットの債務として記録され、アカウントは読み取り専用になります。チャージ後に自動で復旧します。保存済みデータが削除されることはありません。',
    'Count the bytes users download from Playground storage. A metered price bills them with the daily settlement; the daily limits refuse the transfer that would cross them.':
      'ユーザーが Playground ストレージからダウンロードしたバイト数を計測します。従量制の場合は日次精算で課金され、1 日の上限を超える転送は拒否されます。',
    'Give one user group a different free allowance. A group without an entry uses the global allowance.':
      '特定のユーザーグループに別の無料枠を設定します。エントリのないグループは全体の無料枠を使用します。',
    'One GB-day costs one thirtieth of this monthly price. Stored bytes are charged from the wallet, never silently deleted.':
      '1 GB-日はこの月額単価の 30 分の 1 で課金されます。保存されたバイトはウォレットから課金され、黙って削除されることはありません。',
    'Review, export and reconcile the daily storage charges the gateway recorded.':
      'ゲートウェイが記録した日次のストレージ料金を確認・エクスポート・照合します。',
    'Stored bytes up to this allowance are free; only the part above it is billed.':
      'この無料枠までの保存バイトは無料で、超過分のみ課金されます。',
    'Charge each account the peak bytes it stores per day and record the daily charge in the wallet ledger. Disabled by default.':
      'アカウントごとに 1 日の保存ピークバイトを課金し、日次の料金をウォレット台帳に記録します。既定では無効です。',
    'Multiply storage and egress charges by the account group ratio, the same ratio the relay uses for model prices.':
      'ストレージとエグレスの料金にアカウントのグループ比率を掛けます。中継がモデル価格に使う比率と同じです。',
    'Found {{count}} accounts whose storage charges deviate from the wallet ledger.':
      'ストレージ料金がウォレット台帳と一致しないアカウントが {{count}} 件見つかりました。',
    'Daily metered storage charges, their free allowance and the wallet debt they raised':
      '日次の従量ストレージ料金、その無料枠、発生したウォレット債務',
    'Save storage billing': 'ストレージ課金設定を保存',
    Grace: '猶予中',
    'Playground storage billing for {{date}}: {{quota}} quota charged, {{bytes}} bytes billed':
      '{{date}} の Playground ストレージ課金：{{quota}} クォータを請求、{{bytes}} バイトを課金',
  },
  ru: {
    '0 means unlimited.': '0 означает отсутствие ограничений.',
    'All accounts': 'Все аккаунты',
    'Apply the user group ratio': 'Применять коэффициент группы пользователей',
    Billed: 'Начислено',
    Charge: 'Плата',
    'Charged per downloaded GB when egress is metered.':
      'Списывается за каждый скачанный ГБ при метрическом исходящем трафике.',
    'Daily download limit (bytes)': 'Дневной лимит скачивания (байты)',
    'Daily download request limit': 'Дневной лимит запросов на скачивание',
    'Daily storage charges will appear here':
      'Ежедневные платежи за хранилище появятся здесь',
    Date: 'Дата',
    Debt: 'Долг',
    'Downloaded today': 'Скачано сегодня',
    'Egress mode': 'Режим исходящего трафика',
    'Egress price per GB (USD)': 'Цена исходящего трафика за ГБ (USD)',
    Egress: 'Исходящий трафик',
    'Enable metered storage billing': 'Включить оплату хранилища по метрике',
    'End date': 'Дата окончания',
    'Enter a non-negative whole number.':
      'Введите неотрицательное целое число.',
    'Failed to export the storage ledger':
      'Не удалось экспортировать журнал хранилища',
    'Failed to load the storage ledger':
      'Не удалось загрузить журнал хранилища',
    'Failed to reconcile the storage ledger':
      'Не удалось сверить журнал хранилища',
    'Free allowance (GB)': 'Бесплатный лимит (ГБ)',
    'Free allowance per account (GB)': 'Бесплатный лимит на аккаунт (ГБ)',
    'Grace period (days)': 'Льготный период (дней)',
    'Group free storage overrides':
      'Переопределения бесплатного хранилища по группам',
    Metered: 'По метрике',
    'No storage ledger entries found': 'Записи журнала хранилища не найдены',
    'Open storage ledger': 'Открыть журнал хранилища',
    'Peak stored today': 'Пиковый объём за сегодня',
    'Playground Storage Billing': 'Оплата хранилища Playground',
    Reconcile: 'Сверить',
    'Reconciling...': 'Сверка...',
    'Start date': 'Дата начала',
    'Storage billing': 'Оплата хранилища',
    'Storage charges match the wallet ledger.':
      'Платежи за хранилище совпадают с журналом кошелька.',
    'Storage ledger exported': 'Журнал хранилища экспортирован',
    'Storage ledger': 'Журнал хранилища',
    'Storage price per GB-month (USD)': 'Цена хранилища за ГБ-месяц (USD)',
    Unmetered: 'Без метрики',
    'Your wallet has an unpaid balance, so uploading new Playground data is read-only until you top up.':
      'У вашего кошелька есть непогашенный остаток, поэтому загрузка новых данных Playground доступна только для чтения до пополнения.',
    'Unmetered still enforces the daily limits; metered also charges the downloaded GBs.':
      'Без метрики дневные лимиты всё равно действуют; с метрикой дополнительно списываются скачанные ГБ.',
    'A day whose charge the wallet cannot cover becomes wallet debt and the account becomes read-only; it recovers automatically after a top-up. Stored data is never deleted.':
      'Сумма, которую кошелёк не может покрыть, становится долгом кошелька, а аккаунт переходит в режим только для чтения; после пополнения доступ восстанавливается автоматически. Сохранённые данные никогда не удаляются.',
    'Count the bytes users download from Playground storage. A metered price bills them with the daily settlement; the daily limits refuse the transfer that would cross them.':
      'Учитывает байты, скачанные пользователями из хранилища Playground. При метрической цене они списываются при ежедневном расчёте; дневные лимиты отклоняют передачу, которая их превысит.',
    'Give one user group a different free allowance. A group without an entry uses the global allowance.':
      'Задайте отдельной группе пользователей другую бесплатную квоту. Группа без записи использует общий лимит.',
    'One GB-day costs one thirtieth of this monthly price. Stored bytes are charged from the wallet, never silently deleted.':
      'Один ГБ-день стоит одну тридцатую этой месячной цены. Занятые байты списываются с кошелька и никогда не удаляются без предупреждения.',
    'Review, export and reconcile the daily storage charges the gateway recorded.':
      'Просматривайте, экспортируйте и сверяйте ежедневные платежи за хранилище, записанные шлюзом.',
    'Stored bytes up to this allowance are free; only the part above it is billed.':
      'Байты в пределах этого лимита бесплатны; оплачивается только превышение.',
    'Charge each account the peak bytes it stores per day and record the daily charge in the wallet ledger. Disabled by default.':
      'Списывает с каждого аккаунта пиковый объём хранения за день и записывает ежедневный платёж в журнал кошелька. По умолчанию отключено.',
    'Multiply storage and egress charges by the account group ratio, the same ratio the relay uses for model prices.':
      'Умножает плату за хранилище и исходящий трафик на коэффициент группы аккаунта — тот же коэффициент, что релей применяет к ценам моделей.',
    'Found {{count}} accounts whose storage charges deviate from the wallet ledger.':
      'Найдено {{count}} аккаунтов, чьи платежи за хранилище расходятся с журналом кошелька.',
    'Daily metered storage charges, their free allowance and the wallet debt they raised':
      'Ежедневные метрические платежи за хранилище, их бесплатный лимит и возникший долг кошелька',
    'Save storage billing': 'Сохранить оплату хранилища',
    Grace: 'Льготный период',
    'Playground storage billing for {{date}}: {{quota}} quota charged, {{bytes}} bytes billed':
      'Оплата хранилища Playground за {{date}}: списано {{quota}} квоты, оплачено {{bytes}} байт',
  },
  vi: {
    '0 means unlimited.': '0 nghĩa là không giới hạn.',
    'All accounts': 'Tất cả tài khoản',
    'Apply the user group ratio': 'Áp dụng tỷ lệ nhóm người dùng',
    Billed: 'Đã tính phí',
    Charge: 'Phí',
    'Charged per downloaded GB when egress is metered.':
      'Tính phí theo mỗi GB tải xuống khi lưu lượng ra được đo lường.',
    'Daily download limit (bytes)': 'Giới hạn tải xuống mỗi ngày (byte)',
    'Daily download request limit': 'Giới hạn số yêu cầu tải xuống mỗi ngày',
    'Daily storage charges will appear here':
      'Phí lưu trữ hằng ngày sẽ hiển thị ở đây',
    Date: 'Ngày',
    Debt: 'Nợ',
    'Downloaded today': 'Đã tải hôm nay',
    'Egress mode': 'Chế độ lưu lượng ra',
    'Egress price per GB (USD)': 'Giá lưu lượng ra mỗi GB (USD)',
    Egress: 'Lưu lượng ra',
    'Enable metered storage billing': 'Bật tính phí lưu trữ theo đo lường',
    'End date': 'Ngày kết thúc',
    'Enter a non-negative whole number.': 'Nhập một số nguyên không âm.',
    'Failed to export the storage ledger': 'Không xuất được sổ cái lưu trữ',
    'Failed to load the storage ledger': 'Không tải được sổ cái lưu trữ',
    'Failed to reconcile the storage ledger':
      'Không đối chiếu được sổ cái lưu trữ',
    'Free allowance (GB)': 'Hạn mức miễn phí (GB)',
    'Free allowance per account (GB)': 'Hạn mức miễn phí mỗi tài khoản (GB)',
    'Grace period (days)': 'Thời gian gia hạn (ngày)',
    'Group free storage overrides':
      'Ghi đè dung lượng lưu trữ miễn phí theo nhóm',
    Metered: 'Theo đo lường',
    'No storage ledger entries found': 'Không có bản ghi sổ cái lưu trữ',
    'Open storage ledger': 'Mở sổ cái lưu trữ',
    'Peak stored today': 'Dung lượng lưu trữ đỉnh hôm nay',
    'Playground Storage Billing': 'Tính phí lưu trữ Playground',
    Reconcile: 'Đối chiếu',
    'Reconciling...': 'Đang đối chiếu...',
    'Start date': 'Ngày bắt đầu',
    'Storage billing': 'Tính phí lưu trữ',
    'Storage charges match the wallet ledger.':
      'Phí lưu trữ khớp với sổ cái ví.',
    'Storage ledger exported': 'Đã xuất sổ cái lưu trữ',
    'Storage ledger': 'Sổ cái lưu trữ',
    'Storage price per GB-month (USD)': 'Giá lưu trữ mỗi GB-tháng (USD)',
    Unmetered: 'Không đo lường',
    'Your wallet has an unpaid balance, so uploading new Playground data is read-only until you top up.':
      'Ví của bạn còn số dư chưa thanh toán, vì vậy việc tải lên dữ liệu Playground mới ở chế độ chỉ đọc cho đến khi bạn nạp tiền.',
    'Unmetered still enforces the daily limits; metered also charges the downloaded GBs.':
      'Chế độ không đo lường vẫn áp dụng giới hạn hằng ngày; chế độ đo lường còn tính phí các GB đã tải xuống.',
    'A day whose charge the wallet cannot cover becomes wallet debt and the account becomes read-only; it recovers automatically after a top-up. Stored data is never deleted.':
      'Phần phí mà ví không thể chi trả trong ngày sẽ trở thành nợ ví và tài khoản chuyển sang chỉ đọc; tự động khôi phục sau khi nạp tiền. Dữ liệu đã lưu trữ không bao giờ bị xóa.',
    'Count the bytes users download from Playground storage. A metered price bills them with the daily settlement; the daily limits refuse the transfer that would cross them.':
      'Đếm số byte người dùng tải xuống từ kho lưu trữ Playground. Giá đo lường sẽ tính phí khi quyết toán hằng ngày; giới hạn hằng ngày sẽ từ chối lượt tải vượt mức.',
    'Give one user group a different free allowance. A group without an entry uses the global allowance.':
      'Cấp cho một nhóm người dùng hạn mức miễn phí khác. Nhóm không có mục nào sẽ dùng hạn mức chung.',
    'One GB-day costs one thirtieth of this monthly price. Stored bytes are charged from the wallet, never silently deleted.':
      'Mỗi GB-ngày có giá bằng một phần ba mươi mức giá tháng này. Số byte lưu trữ bị trừ từ ví, không bao giờ bị xóa âm thầm.',
    'Review, export and reconcile the daily storage charges the gateway recorded.':
      'Xem, xuất và đối chiếu phí lưu trữ hằng ngày do gateway ghi lại.',
    'Stored bytes up to this allowance are free; only the part above it is billed.':
      'Số byte lưu trữ trong hạn mức này được miễn phí; chỉ phần vượt mức mới bị tính phí.',
    'Charge each account the peak bytes it stores per day and record the daily charge in the wallet ledger. Disabled by default.':
      'Tính phí cho mỗi tài khoản theo số byte lưu trữ đỉnh trong ngày và ghi phí hằng ngày vào sổ cái ví. Mặc định tắt.',
    'Multiply storage and egress charges by the account group ratio, the same ratio the relay uses for model prices.':
      'Nhân phí lưu trữ và lưu lượng ra với tỷ lệ nhóm của tài khoản, cùng tỷ lệ mà relay dùng cho giá model.',
    'Found {{count}} accounts whose storage charges deviate from the wallet ledger.':
      'Tìm thấy {{count}} tài khoản có phí lưu trữ lệch với sổ cái ví.',
    'Daily metered storage charges, their free allowance and the wallet debt they raised':
      'Phí lưu trữ đo lường hằng ngày, hạn mức miễn phí và khoản nợ ví phát sinh',
    'Save storage billing': 'Lưu tính phí lưu trữ',
    Grace: 'Gia hạn',
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
