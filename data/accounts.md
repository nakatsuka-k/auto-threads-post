# Threads Accounts

Threads のログイン情報を表で管理します。

| enabled | label | username | password |
| --- | --- | --- | --- |
| true | main_01 | your_mail_or_username | your_password |
| false | sub_01 | another_mail_or_username | another_password |

- enabled=true の行だけ投稿対象になります。
- label は管理用の識別子です。
- password を平文で置く運用が不安な場合は、将来的に .env 参照へ切り替えてください。
