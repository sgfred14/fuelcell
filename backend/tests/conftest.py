import os
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
os.environ["SIM_AUTOSTART"] = "0"
os.environ["DISABLE_AE"] = "1"          # API tests run on the physics checks; the learned model has its own test
