package tw.skyhong.infovore.health.robo

import android.content.Intent
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import tw.skyhong.infovore.health.DestinationChange
import tw.skyhong.infovore.health.EndpointPolicy
import tw.skyhong.infovore.health.FakeIngestServer
import tw.skyhong.infovore.health.HomeActivity
import tw.skyhong.infovore.health.MainActivity
import tw.skyhong.infovore.health.screen.ScreenSettings

@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w411dp-h891dp-xxhdpi")
class HomeActivityTest {
    @Test fun launcherOpensReadingHomeAndRecorderSetupIsAnExplicitAction() {
        val controller = Robolectric.buildActivity(HomeActivity::class.java).setup()
        val activity = controller.get()
        val root = activity.window.decorView
        assertTrue(Robo.hasVisibleText(root, "活動總覽"))
        assertTrue(Robo.hasVisibleText(root, "尚未開始記錄"))
        assertFalse(ScreenSettings(activity).enabled)
        Robo.button(root, "時間軸").performClick()
        assertTrue(Robo.hasVisibleText(root, "回看手機上的一天。"))
        assertTrue(Robo.hasVisibleText(root, "連接手機足跡後"))
        Robo.button(root, "連接手機足跡  →").performClick()
        val intent = shadowOf(activity).nextStartedActivity
        assertEquals(MainActivity::class.java.name, intent.component?.className)
        assertTrue(intent.getBooleanExtra(MainActivity.EXTRA_OPEN_SCREEN, false))
        controller.pause().stop().destroy()
    }

    @Test fun timelineReadsRealHttpCardsAndChangingDateRequestsAnotherDay() {
        FakeIngestServer().use { server ->
            EndpointPolicy.testHttpHost = "127.0.0.1"
            try {
                val settings = Robo.settings().apply { endpoint = server.endpoint }
                ScreenSettings(Robo.app).saveToken(Robo.PHONE_TOKEN, DestinationChange.normalize(server.endpoint))
                server.responder = { FakeIngestServer.Response(200, """{"status":{"pending":3,"retrying":1,"lastObservationAt":null},"categories":[{"name":"Learning","minutes":10}],"cards":[{"startAt":"2026-11-12T03:00:00Z","endAt":"2026-11-12T03:10:00Z","title":"看口琴教學","summary":"練習吹奏技巧","category":"Learning","apps":["YouTube"],"summarized":true}]}""") }
                val controller = Robolectric.buildActivity(HomeActivity::class.java).setup()
                val activity = controller.get()
                Robo.button(activity.window.decorView, "時間軸").performClick()
                Robo.waitFor { Robo.hasVisibleText(activity.window.decorView, "10 分鐘") }
                assertTrue(Robo.hasVisibleText(activity.window.decorView, "YouTube"))
                assertTrue(Robo.hasVisibleText(activity.window.decorView, "1 筆重試中"))
                assertEquals("Bearer ${Robo.PHONE_TOKEN}", server.requests.last().authorization)
                assertTrue(server.requests.last().path.contains("deviceId=${settings.deviceId}"))
                val before = server.requests.last().path
                Robo.button(activity.window.decorView, "←").performClick()
                Robo.waitFor { server.requests.last().path != before }
                controller.pause().stop().destroy()
            } finally { EndpointPolicy.testHttpHost = null }
        }
    }

    @Test fun browseShowsNativeContentAndFiltersWithoutUsingThePhoneToken() {
        FakeIngestServer().use { server ->
            EndpointPolicy.testHttpHost = "127.0.0.1"
            HomeActivity.testPublicEndpoint = server.endpoint
            try {
                server.responder = { FakeIngestServer.Response(200, """{"data":[{"source":"hardcover","title":"一個人的朝聖","mediaKind":"book","occurredAt":"2026-11-12T03:00:00Z"}]}""") }
                val controller = Robolectric.buildActivity(HomeActivity::class.java).setup()
                val root = controller.get().window.decorView
                Robo.button(root, "瀏覽").performClick()
                Robo.waitFor { Robo.hasVisibleText(root, "一個人的朝聖") }
                assertTrue(Robo.hasVisibleText(root, "Hardcover · 書籍"))
                assertFalse(server.requests.last().authorization.orEmpty().contains(Robo.PHONE_TOKEN))
                Robo.button(root, "閱讀").performClick()
                Robo.waitFor { server.requests.last().path.contains("kind=book") }
                assertFalse(Robo.descendants(root).any { it is android.webkit.WebView })
                controller.pause().stop().destroy()
            } finally { EndpointPolicy.testHttpHost = null; HomeActivity.testPublicEndpoint = null }
        }
    }

    @Test
    @Config(qualifiers = "w360dp-h740dp-night-xhdpi", fontScale = 1.3f)
    fun compactDarkHomeKeepsAllFourNavigationActionsWithLargeText() {
        val controller = Robolectric.buildActivity(HomeActivity::class.java).setup()
        val root = controller.get().window.decorView
        for (label in listOf("總覽", "瀏覽", "時間軸", "設定")) {
            val button = Robo.button(root, label)
            assertTrue(button.isShown)
            assertTrue(button.minimumHeight >= Robo.dp(controller.get(), 48))
        }
        assertTrue(Robo.hasVisibleText(root, "活動總覽"))
        controller.pause().stop().destroy()
    }

    @Test
    @org.robolectric.annotation.GraphicsMode(org.robolectric.annotation.GraphicsMode.Mode.NATIVE)
    @Config(qualifiers = "w411dp-h891dp-night-xxhdpi")
    fun dashboardMatchesTheDayflowSectionsAndOpensADayFromItsBarList() {
        FakeIngestServer().use { server ->
            EndpointPolicy.testHttpHost = "127.0.0.1"
            HomeActivity.testPublicEndpoint = server.endpoint
            try {
                val settings = Robo.settings().apply { endpoint = server.endpoint }
                ScreenSettings(Robo.app).saveToken(Robo.PHONE_TOKEN, DestinationChange.normalize(server.endpoint))
                val overview = """{"stats":{"recordedDays":2,"todayMinutes":60,"weeklyHours":1.5,"weeklyActiveHours":1.2},"extra":{"lastSyncedAt":"2026-11-12T03:30:00Z","keywordPools":{"status":"insufficient_history","all":[{"name":"口琴教學","mentions":3}],"distinctive":[]},"categories":[{"name":"Learning","color":"#6A9C78","minutes":60}],"daily":[{"day":"2026-11-12","trackedMinutes":60,"activeMinutes":60,"idleMinutes":0,"categories":[{"name":"Learning","color":"#6A9C78","minutes":60}],"keywords":[]}]}}"""
                server.responder = { request ->
                    if (request.path.startsWith("/api/dayflow.json")) FakeIngestServer.Response(200, "{\"data\":$overview}")
                    else FakeIngestServer.Response(200, "{\"overview\":$overview}")
                }
                val controller = Robolectric.buildActivity(HomeActivity::class.java).setup()
                val root = controller.get().window.decorView
                Robo.waitFor { Robo.hasVisibleText(root, "口琴教學") }
                for (section in listOf("時數總覽", "近期特別常見", "所有近期關鍵字", "本週分類", "最近有紀錄的日子")) assertTrue(Robo.hasVisibleText(root, section))
                assertTrue(Robo.hasVisibleText(root, "歷史資料累積中"))
                val width = Robo.dp(controller.get(), 411)
                val height = Robo.dp(controller.get(), 891)
                root.measure(android.view.View.MeasureSpec.makeMeasureSpec(width, android.view.View.MeasureSpec.EXACTLY), android.view.View.MeasureSpec.makeMeasureSpec(height, android.view.View.MeasureSpec.EXACTLY))
                root.layout(0, 0, width, height)
                val bitmap = android.graphics.Bitmap.createBitmap(width, height, android.graphics.Bitmap.Config.ARGB_8888)
                root.draw(android.graphics.Canvas(bitmap))
                java.io.File("/tmp/infovore-dashboard-0.5.1.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
                bitmap.recycle()
                assertTrue(server.requests.last().path.contains("overview=1"))
                Robo.button(root, "電腦 Dayflow").performClick()
                Robo.waitFor { Robo.hasVisibleText(root, "INFOVORE MIRROR · DAYFLOW") }
                assertTrue(server.requests.last().path.startsWith("/api/dayflow.json"))
                assertFalse(server.requests.last().authorization.orEmpty().contains(Robo.PHONE_TOKEN))
                Robo.button(root, "手機足跡").performClick()
                Robo.waitFor { Robo.hasVisibleText(root, "查看 2026-11-12 活動") }
                Robo.button(root, "查看 2026-11-12 活動  →").performClick()
                Robo.waitFor { server.requests.last().path.contains("day=2026-11-12") }
                controller.pause().stop().destroy()
            } finally { EndpointPolicy.testHttpHost = null; HomeActivity.testPublicEndpoint = null }
        }
    }

    @Test fun aTokenForAnotherDestinationIsNeverUsedToReadActivity() {
        FakeIngestServer().use { server ->
            Robo.settings().endpoint = server.endpoint
            ScreenSettings(Robo.app).saveToken(Robo.PHONE_TOKEN, "https://another.example")
            val controller = Robolectric.buildActivity(HomeActivity::class.java).setup()
            Robo.idle()
            assertTrue(server.requests.isEmpty())
            assertTrue(Robo.hasVisibleText(controller.get().window.decorView, "連接手機足跡後"))
            controller.pause().stop().destroy()
        }
    }
}
