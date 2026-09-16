package app.mixbase.android

import android.app.Application

class MixbaseApplication : Application() {

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        container.session.restore()
    }
}
