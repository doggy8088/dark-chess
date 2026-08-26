import './style.css'
import { App } from './app'

// Invite URLs look like /r/abcdefghjk — join that room straight away.
const inviteMatch = location.pathname.match(/^\/r\/([a-z2-9]{10})$/)

const app = new App()
void app.boot({ joinRoomId: inviteMatch?.[1] })

// Debug handle for diagnosing issues in the field (harmless in production).
;(window as unknown as { __darkChessApp?: App }).__darkChessApp = app
